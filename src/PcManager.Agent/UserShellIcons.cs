using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using PcManager.Agent.Service;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 확장자별 윈도우 셸 아이콘을 로그인한 사용자 기준으로 꺼낸다.
/// 서비스(SYSTEM)는 사용자의 파일 연결(사용자별 기본 앱, 윈도우 앱, 클릭투런 오피스 등)을 보지 못해 기본 아이콘만 나오므로,
/// 사용자 세션에 이 exe를 '--shell-icons'로 잠깐 띄워 꺼내고 결과를 기억한다. 여러 요청은 모아서 한 번에 처리한다.
/// </summary>
public class UserShellIcons(ILogger<UserShellIcons> logger)
{
    public const string HelperArgument = "--shell-icons";

    private static readonly TimeSpan BatchDelay = TimeSpan.FromMilliseconds(150);

    private readonly ConcurrentDictionary<string, Task<byte[]?>> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _lock = new();
    private Dictionary<string, TaskCompletionSource<byte[]?>> _pending = new(StringComparer.OrdinalIgnoreCase);
    private bool _batchScheduled;

    public Task<byte[]?> GetPngAsync(string extension, int size)
    {
        var ext = extension.Trim().TrimStart('.').ToLowerInvariant();
        // 개발용 콘솔 실행은 이미 사용자 권한이다
        if (!AgentHost.IsRunningAsService)
            return Task.FromResult(ShellIcons.GetPng(ext, size));
        return _cache.GetOrAdd($"{ext}:{size}", key => Enqueue(key));
    }

    private Task<byte[]?> Enqueue(string key)
    {
        lock (_lock)
        {
            if (!_pending.TryGetValue(key, out var done))
            {
                done = new TaskCompletionSource<byte[]?>(TaskCreationOptions.RunContinuationsAsynchronously);
                _pending[key] = done;
            }
            if (!_batchScheduled)
            {
                _batchScheduled = true;
                _ = Task.Delay(BatchDelay).ContinueWith(_ => RunBatch(), TaskScheduler.Default);
            }
            return done.Task;
        }
    }

    private void RunBatch()
    {
        Dictionary<string, TaskCompletionSource<byte[]?>> batch;
        lock (_lock)
        {
            batch = _pending;
            _pending = new(StringComparer.OrdinalIgnoreCase);
            _batchScheduled = false;
        }
        if (batch.Count == 0)
            return;

        Dictionary<string, string?>? results = null;
        try
        {
            results = ExtractAsUser(batch.Keys.ToList());
        }
        catch (Exception ex)
        {
            logger.LogWarning("사용자 권한 아이콘 추출 실패, 서비스 권한으로 대신: {Message}", ex.Message);
        }

        foreach (var (key, done) in batch)
        {
            byte[]? png = null;
            if (results is not null && results.TryGetValue(key, out var b64) && b64 is not null)
                png = Convert.FromBase64String(b64);
            if (png is null)
            {
                // 로그인한 사용자가 없거나 실패: 서비스 권한으로라도 (기본 아이콘일 수 있음)
                var parts = key.Split(':');
                png = ShellIcons.GetPng(parts[0], int.Parse(parts[1]));
                // 사용자 권한으로 못 꺼낸 결과는 오래 기억하지 않는다 (로그인 후 다시 시도)
                _ = Task.Delay(TimeSpan.FromMinutes(5)).ContinueWith(_ => _cache.TryRemove(key, out Task<byte[]?>? _), TaskScheduler.Default);
            }
            done.TrySetResult(png);
        }
    }

    /// <summary>사용자 세션에 도우미를 띄워 꺼낸다. 로그인한 사용자가 없으면 null</summary>
    private Dictionary<string, string?>? ExtractAsUser(List<string> keys)
    {
        var session = SessionProcess.GetInteractiveUserSessionId();
        if (session is null)
            return null;

        // 결과 파일: 사용자가 쓸 수 있는 그 사용자의 임시 폴더
        var folder = Path.Combine(SessionProcess.GetUserLocalAppDataFolder(session.Value), "Temp", "PcManagerIcons");
        Directory.CreateDirectory(folder);
        var output = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var exitCode = SessionProcess.StartAsSessionUser(session.Value, Environment.ProcessPath!,
                $"{HelperArgument} \"{output}\" {string.Join(',', keys)}", waitMilliseconds: 20000);
            if (exitCode != 0 || !File.Exists(output))
                throw new InvalidOperationException($"도우미 종료 코드 {exitCode?.ToString() ?? "시간 초과"}");
            return JsonSerializer.Deserialize<Dictionary<string, string?>>(File.ReadAllText(output));
        }
        finally
        {
            try { File.Delete(output); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>도우미 본체 (사용자 세션에서 실행): "확장자:크기" 목록을 꺼내 JSON(base64 PNG)으로 기록</summary>
    public static int RunHelper(string outputPath, string list)
    {
        var result = new Dictionary<string, string?>();
        foreach (var key in list.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = key.Split(':');
            if (parts.Length != 2 || !int.TryParse(parts[1], out var size))
                continue;
            var png = ShellIcons.GetPng(parts[0], size);
            result[key] = png is null ? null : Convert.ToBase64String(png);
        }
        File.WriteAllText(outputPath, JsonSerializer.Serialize(result));
        return 0;
    }
}
