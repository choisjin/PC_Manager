using System.Collections.Concurrent;

namespace PcManager.Server.Services;

/// <summary>
/// 명령/전송 완료를 기다리는 대기자에게 알린다.
/// 반드시 요청을 보내기 전에 WaitAsync로 등록해야 완료 신호를 놓치지 않는다.
/// </summary>
public class CompletionNotifier
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource> _waiters = new();

    public Task WaitAsync(string id, CancellationToken ct)
    {
        var source = _waiters.GetOrAdd(id, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        return source.Task.WaitAsync(ct);
    }

    public void Complete(string id)
    {
        if (_waiters.TryRemove(id, out var source))
            source.TrySetResult();
    }
}
