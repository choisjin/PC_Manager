using System.ComponentModel;
using System.Diagnostics;

namespace PcManager.Agent.Service;

/// <summary>
/// 서비스로 실행될 때, 로그인한 사용자 세션마다 트레이 런처가 떠 있게 유지한다.
/// (로그인 직후 자동 실행, 업데이트 후 다시 실행, 실수로 종료된 경우 복구)
/// </summary>
public class LauncherSupervisor(ILogger<LauncherSupervisor> logger) : BackgroundService
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!AgentHost.IsRunningAsService)
            return; // 개발용 콘솔 실행에서는 런처를 직접 띄운다

        var exePath = Environment.ProcessPath!;
        var processName = Path.GetFileNameWithoutExtension(exePath);
        var failedSessions = new HashSet<int>();

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var running = Process.GetProcessesByName(processName)
                    .Select(p =>
                    {
                        using (p)
                            return p.SessionId;
                    })
                    .ToHashSet();

                foreach (var sessionId in SessionProcess.GetActiveSessionIds())
                {
                    if (running.Contains(sessionId))
                        continue;
                    try
                    {
                        SessionProcess.StartAsSessionUser(sessionId, exePath, "--launcher --tray");
                        failedSessions.Remove(sessionId);
                        logger.LogInformation("세션 {SessionId}에 런처 실행", sessionId);
                    }
                    catch (Win32Exception ex) when (failedSessions.Add(sessionId))
                    {
                        // 같은 세션 실패 로그는 한 번만 남긴다
                        logger.LogWarning("세션 {SessionId}에 런처를 실행하지 못했습니다: {Message}", sessionId, ex.Message);
                    }
                    catch (Win32Exception)
                    {
                        // 이미 기록함
                    }
                }
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
            {
                logger.LogWarning("세션 조회 실패: {Message}", ex.Message);
            }

            await Task.Delay(CheckInterval, stoppingToken);
        }
    }
}
