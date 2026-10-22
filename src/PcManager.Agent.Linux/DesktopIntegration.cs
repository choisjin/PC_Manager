using System.Diagnostics;
using PcManager.Agent.Linux.Remote;

namespace PcManager.Agent.Linux;

/// <summary>
/// 데스크톱에 런처 창(--launcher)을 붙인다: 앱 목록·독(왼쪽 실행 중 표시)용 .desktop, 로그인 자동 실행, 아이콘.
/// 서비스(root)가 시작할 때 파일을 맞추고, 로그인한 사용자가 있으면 그 사용자 권한으로 런처를 띄운다
/// (업데이트는 실행 파일만 바꾸므로 이미 설치된 PC도 여기서 붙는다)
/// </summary>
public static class DesktopIntegration
{
    /// <summary>GTK 앱 ID = .desktop 파일 이름 = 창 WM_CLASS. 독이 창을 이 .desktop(아이콘·이름)에 묶는다</summary>
    public const string AppId = "com.pcmanager.Agent";
    public const string LauncherArgument = "--launcher";
    public const string MinimizedArgument = "--minimized";

    private const string ApplicationsEntry = "/usr/share/applications/" + AppId + ".desktop";
    private const string AutostartEntry = "/etc/xdg/autostart/" + AppId + ".desktop";
    public static string IconPath => Path.Combine(SystemdInstaller.InstallDirectory, "pcmanager-agent.svg");

    private static string Entry(bool autostart) => $"""
        [Desktop Entry]
        Type=Application
        Name=PC Manager 에이전트
        Comment=PC Manager 서버 연결 상태
        Exec={SystemdInstaller.InstalledExe} {LauncherArgument}{(autostart ? " " + MinimizedArgument : "")}
        Icon={IconPath}
        Terminal=false
        Categories=Utility;Network;
        StartupWMClass={AppId}
        StartupNotify=false
        {(autostart ? "X-GNOME-Autostart-enabled=true\n" : "")}
        """;

    // Windows 트레이 아이콘과 같은 모양: 모니터 + 초록 상태 점
    private const string IconSvg = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
          <rect x="6" y="10" width="52" height="34" rx="4" fill="#2b5797"/>
          <rect x="10" y="14" width="44" height="26" rx="2" fill="#e8f0fb"/>
          <rect x="27" y="44" width="10" height="7" fill="#2b5797"/>
          <rect x="18" y="51" width="28" height="4" rx="2" fill="#2b5797"/>
          <circle cx="50" cy="44" r="10" fill="#22a05a" stroke="#ffffff" stroke-width="3"/>
        </svg>
        """;

    /// <summary>.desktop·자동 실행·아이콘 파일을 지금 내용으로 맞춘다 (root)</summary>
    public static void EnsureFiles(ILogger logger)
    {
        try
        {
            var changed = WriteIfDifferent(IconPath, IconSvg);
            changed |= WriteIfDifferent(ApplicationsEntry, Entry(autostart: false));
            changed |= WriteIfDifferent(AutostartEntry, Entry(autostart: true));
            if (changed)
                logger.LogInformation("런처 창 바로 가기를 만들었습니다 ({Path}, 로그인 시 자동 실행)", ApplicationsEntry);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("런처 창 바로 가기를 만들지 못했습니다: {Message}", ex.Message);
        }
    }

    public static void RemoveFiles()
    {
        foreach (var path in new[] { ApplicationsEntry, AutostartEntry, IconPath })
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    /// <summary>
    /// 로그인한 사용자가 있고 그 사용자의 런처가 없으면 그 사용자 권한·세션 환경으로 런처를 (최소화해서) 띄운다.
    /// 로그인 전이면 아무것도 안 한다 (로그인하면 자동 실행 항목이 띄운다)
    /// </summary>
    public static void StartLauncherForSessionUser(ILogger logger)
    {
        var session = DisplayLocator.FindUserSession();
        if (session is not { } found)
            return;
        if (IsLauncherRunning(found.Uid))
            return;
        var user = UserName(found.Uid);
        if (user is null)
            return;

        var info = new ProcessStartInfo("runuser")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add("-u");
        info.ArgumentList.Add(user);
        info.ArgumentList.Add("--");
        info.ArgumentList.Add(SystemdInstaller.InstalledExe);
        info.ArgumentList.Add(LauncherArgument);
        info.ArgumentList.Add(MinimizedArgument);
        // 사용자 세션 환경 그대로 (DISPLAY·XAUTHORITY·세션 D-Bus·XDG_RUNTIME_DIR 등)
        info.Environment.Clear();
        foreach (var (key, value) in found.Environment)
            info.Environment[key] = value;
        try
        {
            var process = Process.Start(info);
            if (process is null)
                return;
            // 출력은 버린다 (파이프가 차서 막히지 않게)
            process.OutputDataReceived += (_, _) => { };
            process.ErrorDataReceived += (_, _) => { };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => process.Dispose();
            logger.LogInformation("런처 창 시작 (사용자 {User})", user);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            logger.LogWarning("런처 창을 띄우지 못했습니다: {Message}", ex.Message);
        }
    }

    /// <summary>제거할 때 떠 있는 런처 창들을 닫는다</summary>
    public static void StopLaunchers()
    {
        foreach (var pid in LauncherProcesses(uid: null))
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                process.Kill();
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // 이미 끝남
            }
        }
    }

    private static bool IsLauncherRunning(int uid) => LauncherProcesses(uid).Any();

    private static IEnumerable<int> LauncherProcesses(int? uid)
    {
        string[] dirs;
        try
        {
            dirs = Directory.GetDirectories("/proc");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            yield break;
        }
        foreach (var dir in dirs)
        {
            if (!int.TryParse(Path.GetFileName(dir), out var pid) || pid == Environment.ProcessId)
                continue;
            string[] cmdline;
            int owner;
            try
            {
                cmdline = File.ReadAllText(Path.Combine(dir, "cmdline")).Split('\0', StringSplitOptions.RemoveEmptyEntries);
                owner = File.ReadLines(Path.Combine(dir, "status"))
                    .Where(l => l.StartsWith("Uid:"))
                    .Select(l => int.Parse(l.Split('\t', ' ', StringSplitOptions.RemoveEmptyEntries)[1]))
                    .FirstOrDefault(-1);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
            {
                continue;
            }
            if (cmdline.Length >= 2 && Path.GetFileName(cmdline[0]) == "pcmanager-agent" && cmdline.Contains(LauncherArgument)
                && (uid is null || owner == uid))
                yield return pid;
        }
    }

    private static string? UserName(int uid)
    {
        try
        {
            foreach (var line in File.ReadLines("/etc/passwd"))
            {
                var parts = line.Split(':');
                if (parts.Length > 2 && parts[2] == uid.ToString())
                    return parts[0];
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
        return null;
    }

    private static bool WriteIfDifferent(string path, string content)
    {
        if (File.Exists(path) && File.ReadAllText(path) == content)
            return false;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        File.SetUnixFileMode(path, (UnixFileMode)0b110_100_100);
        return true;
    }
}
