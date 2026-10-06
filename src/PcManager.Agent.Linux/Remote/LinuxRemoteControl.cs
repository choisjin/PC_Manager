using System.Diagnostics;
using PcManager.Shared;

namespace PcManager.Agent.Linux.Remote;

/// <summary>
/// 원격조작·썸네일 요청을 받으면 X11 화면 환경(DISPLAY, XAUTHORITY)으로 도우미 프로세스(--remote-session)를 띄운다.
/// 도우미가 서버 WebSocket(/api/agent/remote/{세션})에 직접 붙어 화면을 보내고 입력을 받는다 (보는 사람마다 하나).
/// </summary>
public class LinuxRemoteControl(AgentSettingsStore settings, ILogger<LinuxRemoteControl> logger)
{
    public const string SessionArgument = "--remote-session";
    public const string ThumbnailArgument = "--thumb";
    public const string TokenVariable = "PCM_AGENT_TOKEN";

    /// <returns>오류 메시지. 성공이면 null</returns>
    public string? Start(string sessionId, bool thumbnail = false)
    {
        if (!Guid.TryParseExact(sessionId, "N", out _))
            return "잘못된 세션 ID입니다.";

        var current = settings.Current;
        if (!current.HasServer)
            return "서버 주소가 설정되지 않았습니다.";

        var display = DisplayLocator.Find();
        if (display is null)
            return "화면(X11 데스크톱 세션)을 찾지 못했습니다. 로그인된 X11 세션이 있어야 합니다 (Wayland는 지원하지 않음).";

        var server = new Uri(current.ServerUrl);
        var url = new UriBuilder(server)
        {
            Scheme = server.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = AgentRemotePaths.Session(sessionId),
        }.Uri.ToString();

        var info = new ProcessStartInfo(Environment.ProcessPath!)
        {
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
        };
        info.ArgumentList.Add(SessionArgument);
        info.ArgumentList.Add(url);
        if (thumbnail)
            info.ArgumentList.Add(ThumbnailArgument);
        info.Environment["DISPLAY"] = display.Display;
        if (display.XAuthority is not null)
            info.Environment["XAUTHORITY"] = display.XAuthority;
        if (!string.IsNullOrEmpty(current.Token))
            info.Environment[TokenVariable] = current.Token;

        try
        {
            using var process = Process.Start(info);
            logger.LogInformation("{Kind} 시작 (DISPLAY={Display}, PID {Pid})",
                thumbnail ? "썸네일" : "원격조작", display.Display, process?.Id);
            return null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return "원격 도우미를 시작하지 못했습니다: " + ex.Message;
        }
    }
}

/// <summary>X11 접속 정보</summary>
public record X11Display(string Display, string? XAuthority);

/// <summary>
/// 로그인된 사용자의 X11 화면을 찾는다 (서비스는 root라 사용자 세션 환경 변수가 없다).
/// 1) 사용자 프로세스(uid ≥ 1000) 중 DISPLAY를 가진 것의 DISPLAY·XAUTHORITY
/// 2) 없으면 X 서버(Xorg) 실행 인자의 -auth 파일과 :0
/// </summary>
public static class DisplayLocator
{
    public static X11Display? Find()
    {
        // 직접 실행(--console)하면서 DISPLAY가 이미 있으면 그대로
        if (Environment.GetEnvironmentVariable("DISPLAY") is { Length: > 0 } own)
            return new X11Display(own, Environment.GetEnvironmentVariable("XAUTHORITY"));

        X11Display? fallback = null;
        foreach (var dir in SafeEnumerate("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(dir), out _))
                continue;
            var environment = ReadNullSeparated(Path.Combine(dir, "environ"));
            if (environment.TryGetValue("DISPLAY", out var display) && display.Length > 0)
            {
                environment.TryGetValue("XAUTHORITY", out var xauth);
                var candidate = new X11Display(display, string.IsNullOrEmpty(xauth) ? null : xauth);
                // 일반 사용자 프로세스를 우선 (root 데몬의 DISPLAY는 엉뚱할 수 있다).
                // Wayland 세션의 DISPLAY(XWayland)는 X 프로그램 창만 보이므로 후보로만 둔다
                var wayland = environment.TryGetValue("XDG_SESSION_TYPE", out var type) && type == "wayland";
                if (OwnerUid(dir) >= 1000 && !wayland)
                    return candidate;
                fallback ??= candidate;
            }
        }
        if (fallback is not null)
            return fallback;

        // 로그인 화면 등: X 서버의 -auth 파일
        foreach (var dir in SafeEnumerate("/proc"))
        {
            var cmdline = ReadCmdline(Path.Combine(dir, "cmdline"));
            if (cmdline.Count == 0 || !(cmdline[0].EndsWith("Xorg") || cmdline[0].EndsWith("/X") || cmdline[0] == "X"))
                continue;
            var display = cmdline.FirstOrDefault(a => a.StartsWith(':')) ?? ":0";
            var authIndex = cmdline.IndexOf("-auth");
            return new X11Display(display, authIndex >= 0 && authIndex + 1 < cmdline.Count ? cmdline[authIndex + 1] : null);
        }

        return File.Exists("/tmp/.X11-unix/X0") ? new X11Display(":0", null) : null;
    }

    private static IEnumerable<string> SafeEnumerate(string path)
    {
        try
        {
            return Directory.GetDirectories(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static Dictionary<string, string> ReadNullSeparated(string path)
    {
        var result = new Dictionary<string, string>();
        try
        {
            foreach (var pair in File.ReadAllText(path).Split('\0', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = pair.IndexOf('=');
                if (eq > 0)
                    result[pair[..eq]] = pair[(eq + 1)..];
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 끝난 프로세스·권한 없음
        }
        return result;
    }

    private static List<string> ReadCmdline(string path)
    {
        try
        {
            return [.. File.ReadAllText(path).Split('\0', StringSplitOptions.RemoveEmptyEntries)];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static int OwnerUid(string procDir)
    {
        try
        {
            foreach (var line in File.ReadLines(Path.Combine(procDir, "status")))
            {
                if (line.StartsWith("Uid:"))
                    return int.Parse(line.Split('\t', ' ', StringSplitOptions.RemoveEmptyEntries)[1]);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
        {
        }
        return -1;
    }
}
