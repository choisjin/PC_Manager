using System.Collections.Concurrent;

namespace PcManager.Server.Services;

/// <summary>
/// 브라우저 영상 요청 ↔ 에이전트 HTTP 업로드를 잇는다.
/// 브라우저 요청이 스트림을 하나 만들고(Create) 에이전트에게 StreamFileRange를 부르면,
/// 에이전트가 POST로 올리는 본문을 받아(Accept) 브라우저 응답으로 그대로 흘려보낸다. 서버 디스크는 거치지 않는다.
/// </summary>
public sealed class MediaStreamBroker
{
    private readonly ConcurrentDictionary<string, Pending> _pending = new();
    // StreamFileRange가 없는 옛 에이전트: 잠시 조각 중계만 쓴다 (에이전트가 업데이트되면 다시 시도)
    private readonly ConcurrentDictionary<string, DateTime> _unsupported = new();
    private static readonly TimeSpan RetryUnsupportedAfter = TimeSpan.FromMinutes(10);

    public sealed class Pending
    {
        /// <summary>에이전트가 올리는 본문 (붙으면 채워진다)</summary>
        public TaskCompletionSource<Stream> Body { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        /// <summary>브라우저로 다 보냈거나(true) 브라우저가 끊었다(false) → 에이전트 요청을 끝낸다</summary>
        public TaskCompletionSource<bool> Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public (string Id, Pending Pending) Create()
    {
        var id = Guid.NewGuid().ToString("N");
        var pending = new Pending();
        _pending[id] = pending;
        return (id, pending);
    }

    public void Forget(string id) => _pending.TryRemove(id, out _);

    /// <summary>에이전트의 POST: 본문을 넘겨주고 브라우저 쪽이 끝날 때까지 기다린다. false면 브라우저가 끊음 → 연결을 끊어 에이전트도 멈추게</summary>
    public async Task<bool?> AcceptAsync(string id, Stream body, CancellationToken ct)
    {
        if (!_pending.TryRemove(id, out var pending))
            return null;
        if (!pending.Body.TrySetResult(body))
            return null;
        try
        {
            return await pending.Done.Task.WaitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            pending.Done.TrySetResult(false);
            return false;
        }
    }

    public bool IsUnsupported(string agentId) =>
        _unsupported.TryGetValue(agentId, out var since) && DateTime.UtcNow - since < RetryUnsupportedAfter;

    public void MarkUnsupported(string agentId) => _unsupported[agentId] = DateTime.UtcNow;
}
