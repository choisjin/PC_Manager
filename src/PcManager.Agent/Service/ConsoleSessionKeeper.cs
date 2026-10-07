using System.ComponentModel;

namespace PcManager.Agent.Service;

/// <summary>
/// 원격 데스크톱(RDP) 창을 닫아 세션이 끊기면, 그 세션을 바로 물리 콘솔로 옮긴다 (tscon 세션 /dest:console).
/// 그러면 PC 화면이 로그인(잠금) 화면이 아니라 로그인한 바탕화면 그대로 남아 화면을 쓰는 테스트·원격조작·썸네일이 계속 된다.
/// 콘솔에 이미 다른 사용자가 로그인해 있으면 건드리지 않는다. 로그아웃(세션 종료)한 경우는 옮길 세션이 없어 로그인 화면이 남는다.
/// </summary>
public class ConsoleSessionKeeper(ILogger<ConsoleSessionKeeper> logger) : BackgroundService
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(2);
    // 옮기지 못한 세션은 잠시 뒤에 다시 시도한다 (같은 실패 로그가 쌓이지 않게)
    private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // tscon은 SYSTEM 서비스에서만 암호 없이 된다
        if (!AgentHost.IsRunningAsService || !OperatingSystem.IsWindows())
            return;

        var failedAt = new Dictionary<int, DateTime>();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TryKeepDesktop(failedAt);
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
            {
                logger.LogDebug("세션 확인 실패: {Message}", ex.Message);
            }
            await Task.Delay(CheckInterval, stoppingToken);
        }
    }

    private void TryKeepDesktop(Dictionary<int, DateTime> failedAt)
    {
        var disconnected = SessionProcess.GetDisconnectedUserSessionIds();
        if (disconnected.Count == 0)
            return;

        // 콘솔이 로그인 화면일 때만 (누가 콘솔에 로그인해 쓰고 있으면 그대로 둔다)
        if (SessionProcess.GetConsoleSessionId() is { } console && SessionProcess.GetUserName(console).Length > 0)
            return;

        foreach (var sessionId in disconnected)
        {
            if (failedAt.TryGetValue(sessionId, out var at) && DateTime.UtcNow - at < RetryAfterFailure)
                continue;
            if (SessionProcess.ConnectSessionToConsole(sessionId))
            {
                failedAt.Remove(sessionId);
                logger.LogInformation("끊긴 세션 {SessionId}({User})을 콘솔로 옮겨 바탕화면을 유지했습니다", sessionId, SessionProcess.GetUserName(sessionId));
                return; // 콘솔에는 세션 하나만
            }
            failedAt[sessionId] = DateTime.UtcNow;
            logger.LogWarning("끊긴 세션 {SessionId}을 콘솔로 옮기지 못했습니다 (tscon)", sessionId);
        }
    }
}
