using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using PcManager.Agent.Service;
using PcManager.Shared;

namespace PcManager.Agent.Remote;

/// <summary>
/// 서버의 원격조작 요청을 받아 화면이 있는 세션에 원격조작 프로세스(--remote-session)를 띄운다.
/// 서비스(Session 0)는 화면에 접근할 수 없으므로 캡처/입력은 그 프로세스가 맡는다.
/// </summary>
public class RemoteControlService(AgentSettingsStore settings, ILogger<RemoteControlService> logger)
{
    public const string SessionArgument = "--remote-session";

    /// <returns>오류 메시지. 성공하면 null</returns>
    public string? Start(string sessionId)
    {
        if (!Guid.TryParseExact(sessionId, "N", out _))
            return "잘못된 세션 ID입니다.";

        var current = settings.Current;
        if (!current.HasServer)
            return "서버 주소가 설정되지 않았습니다.";

        var server = new Uri(current.ServerUrl);
        var url = new UriBuilder(server)
        {
            Scheme = server.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = AgentRemotePaths.Session(sessionId),
        }.Uri.ToString();

        var exePath = Environment.ProcessPath!;
        try
        {
            if (AgentHost.IsRunningAsService)
            {
                var sessionIdToUse = SessionProcess.GetConsoleSessionId()
                    ?? SessionProcess.GetActiveSessionIds().Cast<int?>().FirstOrDefault();
                if (sessionIdToUse is not { } target)
                    return "화면이 있는 세션을 찾지 못했습니다.";

                var pid = SessionProcess.StartAsSystemInSession(target, exePath, $"{SessionArgument} \"{url}\"");
                logger.LogInformation("원격조작 시작: 세션 {SessionId}, PID {Pid}", target, pid);
            }
            else
            {
                // 개발용 콘솔 실행: 현재 사용자 세션에서 바로 띄운다
                var start = new ProcessStartInfo(exePath) { UseShellExecute = false };
                start.ArgumentList.Add(SessionArgument);
                start.ArgumentList.Add(url);
                start.Environment[RemoteSessionApp.TokenEnvironmentVariable] = current.Token;
                using var process = Process.Start(start);
                logger.LogInformation("원격조작 시작 (콘솔 모드), PID {Pid}", process?.Id);
            }
            return null;
        }
        catch (Win32Exception ex)
        {
            logger.LogWarning("원격조작 프로세스를 시작하지 못했습니다: {Message}", ex.Message);
            return $"원격조작 프로세스를 시작하지 못했습니다: {ex.Message}";
        }
    }

    /// <summary>
    /// Ctrl+Alt+Del. 서비스에서만 보낼 수 있고, "소프트웨어 SAS 생성" 정책이 켜져 있어야 한다 (없으면 켠다).
    /// </summary>
    public string? SendSecureAttention()
    {
        if (!AgentHost.IsRunningAsService)
            return "서비스로 실행 중일 때만 Ctrl+Alt+Del을 보낼 수 있습니다.";

        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
            // 1: 서비스 허용, 3: 서비스 + 접근성 앱. 이미 허용돼 있으면 그대로 둔다
            var value = key.GetValue("SoftwareSASGeneration") as int? ?? 0;
            if ((value & 1) == 0)
                key.SetValue("SoftwareSASGeneration", value | 1, RegistryValueKind.DWord);

            SendSAS(false);
            logger.LogInformation("Ctrl+Alt+Del 전송");
            return null;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or DllNotFoundException or EntryPointNotFoundException)
        {
            return $"Ctrl+Alt+Del을 보내지 못했습니다: {ex.Message}";
        }
    }

    [DllImport("sas.dll")]
    private static extern void SendSAS(bool asUser);
}
