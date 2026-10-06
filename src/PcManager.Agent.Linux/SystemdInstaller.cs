using System.Diagnostics;
using System.Text.Json;

namespace PcManager.Agent.Linux;

/// <summary>
/// 설치: 실행 파일을 /opt/pcmanager-agent로 복사, 필요한 패키지 설치(apt), systemd 서비스 등록·시작.
/// 설정은 /var/lib/pcmanager-agent/agent.json (Windows의 agent.json과 같은 형식)
/// </summary>
public static class SystemdInstaller
{
    public const string InstallDirectory = "/opt/pcmanager-agent";
    public static string InstalledExe => Path.Combine(InstallDirectory, "pcmanager-agent");
    private const string UnitPath = "/etc/systemd/system/pcmanager-agent.service";
    private const string LinkPath = "/usr/local/bin/pcmanager-agent";

    /// <summary>원격조작에 필요한 프로그램 (화면 캡처·인코딩, 문자 입력, 클립보드, 모니터 목록, XTest)</summary>
    private static readonly string[] Packages = ["ffmpeg", "xdotool", "xclip", "x11-xserver-utils", "libxtst6", "libx11-6"];

    public static int Install(string? serverUrl)
    {
        if (!RequireRoot())
            return 1;

        Step("필요한 프로그램 확인 (ffmpeg, xdotool, xclip, xrandr)");
        InstallPackages();

        Step($"실행 파일 복사 → {InstalledExe}");
        Directory.CreateDirectory(InstallDirectory);
        var self = Environment.ProcessPath!;
        if (!string.Equals(Path.GetFullPath(self), InstalledExe, StringComparison.Ordinal))
        {
            // 실행 중인 파일도 이름 바꾸기로 교체할 수 있다 (서비스 업그레이드)
            var temp = InstalledExe + ".new";
            File.Copy(self, temp, overwrite: true);
            File.SetUnixFileMode(temp, (UnixFileMode)0b111_101_101);
            File.Move(temp, InstalledExe, overwrite: true);
        }
        if (!File.Exists(LinkPath))
            File.CreateSymbolicLink(LinkPath, InstalledExe);

        if (serverUrl is not null)
        {
            Step($"서버 주소 저장: {serverUrl}");
            SaveServer(serverUrl);
        }
        else if (!File.Exists(AgentOptions.InstalledConfigPath))
        {
            Console.WriteLine("  ! 서버 주소가 없습니다. 나중에: sudo pcmanager-agent --set-server http://서버주소:포트");
        }

        Step("systemd 서비스 등록·시작 (pcmanager-agent)");
        File.WriteAllText(UnitPath, UnitText);
        if (!Run("systemctl", "daemon-reload") || !Run("systemctl", "enable", "pcmanager-agent") || !Run("systemctl", "restart", "pcmanager-agent"))
        {
            Console.Error.WriteLine($"서비스를 등록·시작하지 못했습니다 (systemd가 없는 환경?). 직접 실행: {InstalledExe} --service");
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("설치 완료. 상태: systemctl status pcmanager-agent   로그: journalctl -u pcmanager-agent -f");
        Console.WriteLine("원격조작은 X11 데스크톱 세션(로그인 화면에서 'Ubuntu on Xorg')이 있어야 합니다.");
        return 0;
    }

    // graphical.target 뒤로 순서를 걸면 안 된다: multi-user.target이 이 서비스를 Wants하면 자동으로 이 서비스 뒤에 오고,
    // graphical.target은 multi-user.target 뒤에 오므로 순환이 생겨 부팅 때 systemd가 이 서비스 시작을 빼 버린다.
    // X 세션은 원격조작 요청 때 찾으므로 화면보다 먼저 떠도 된다
    private static string UnitText => $"""
        [Unit]
        Description=PC Manager Agent
        After=network-online.target
        Wants=network-online.target

        [Service]
        Type=notify
        ExecStart={InstalledExe} --service
        Restart=always
        RestartSec=5
        # 원격 도우미가 쓰는 /tmp (사용자 X 세션에 접근하므로 격리하지 않는다)
        PrivateTmp=false

        [Install]
        WantedBy=multi-user.target
        """;

    /// <summary>
    /// 서비스 시작 시: 예전 버전이 쓴 유닛 파일(부팅 때 안 뜨는 순환 의존)을 지금 내용으로 고친다.
    /// 업데이트는 실행 파일만 바꾸므로 이미 설치된 PC는 여기서 고쳐진다
    /// </summary>
    public static void RepairUnit(ILogger logger)
    {
        try
        {
            if (!Environment.IsPrivilegedProcess || Environment.ProcessPath != InstalledExe || !File.Exists(UnitPath))
                return;
            if (File.ReadAllText(UnitPath) == UnitText)
                return;
            File.WriteAllText(UnitPath, UnitText);
            Run(["systemctl", "daemon-reload"], quiet: true);
            Run(["systemctl", "reenable", "pcmanager-agent"], quiet: true);
            logger.LogInformation("systemd 유닛 파일을 고쳤습니다 ({Path}, 재부팅 시 자동 시작)", UnitPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("systemd 유닛 파일을 고치지 못했습니다: {Message}", ex.Message);
        }
    }

    public static int Uninstall(bool purge)
    {
        if (!RequireRoot())
            return 1;
        Step("서비스 중지·삭제");
        Run("systemctl", "disable", "--now", "pcmanager-agent");
        File.Delete(UnitPath);
        Run("systemctl", "daemon-reload");
        if (File.Exists(LinkPath) || new FileInfo(LinkPath).LinkTarget is not null)
            File.Delete(LinkPath);
        if (Directory.Exists(InstallDirectory))
            Directory.Delete(InstallDirectory, recursive: true);
        if (purge && Directory.Exists(AgentOptions.DefaultDataDirectory))
        {
            Step("설정·데이터 삭제");
            Directory.Delete(AgentOptions.DefaultDataDirectory, recursive: true);
        }
        Console.WriteLine("제거 완료");
        return 0;
    }

    public static int SetServer(string? serverUrl)
    {
        if (!RequireRoot())
            return 1;
        if (serverUrl is null)
        {
            Console.Error.WriteLine("서버 주소가 올바르지 않습니다. 예: http://192.168.0.10:5063");
            return 1;
        }
        SaveServer(serverUrl);
        Run("systemctl", "restart", "pcmanager-agent");
        Console.WriteLine($"서버 주소를 {serverUrl}(으)로 바꾸고 서비스를 다시 시작했습니다.");
        return 0;
    }

    /// <summary>agent.json의 서버 주소만 바꾼다 (토큰·태그는 유지)</summary>
    private static void SaveServer(string serverUrl)
    {
        var path = AgentOptions.InstalledConfigPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var agent = new Dictionary<string, object?> { ["ServerUrl"] = serverUrl, ["Enabled"] = true, ["Tags"] = Array.Empty<string>(), ["Token"] = "" };
        if (File.Exists(path))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                if (doc.RootElement.TryGetProperty("Agent", out var existing))
                {
                    foreach (var p in existing.EnumerateObject())
                        agent[p.Name] = p.Value.Clone();
                }
            }
            catch (JsonException)
            {
                // 손상된 파일은 새로 쓴다
            }
            agent["ServerUrl"] = serverUrl;
            agent["Enabled"] = true;
        }
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new { Agent = agent }, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, path, overwrite: true);
    }

    private static void InstallPackages()
    {
        var missing = Packages.Where(p => !Run("dpkg", "-s", p, quiet: true)).ToList();
        if (missing.Count == 0)
            return;
        if (!File.Exists("/usr/bin/apt-get"))
        {
            Console.WriteLine($"  ! 다음 패키지를 직접 설치하세요: {string.Join(' ', missing)}");
            return;
        }
        Console.WriteLine($"  설치: {string.Join(' ', missing)}");
        Run("apt-get", "update", "-qq");
        if (!Run(["apt-get", "install", "-y", "-qq", .. missing]))
            Console.WriteLine("  ! 패키지 설치에 실패했습니다. 원격조작이 안 되면 직접 설치하세요: sudo apt install " + string.Join(' ', missing));
    }

    private static bool RequireRoot()
    {
        if (Environment.IsPrivilegedProcess)
            return true;
        Console.Error.WriteLine("관리자 권한이 필요합니다: sudo 를 붙여 실행하세요.");
        return false;
    }

    private static void Step(string text) => Console.WriteLine("==> " + text);

    private static bool Run(params string[] command) => Run(command, quiet: false);

    private static bool Run(string file, string arg1, string arg2, bool quiet) => Run([file, arg1, arg2], quiet);

    private static bool Run(string[] command, bool quiet)
    {
        try
        {
            var info = new ProcessStartInfo(command[0])
            {
                UseShellExecute = false,
                RedirectStandardOutput = quiet,
                RedirectStandardError = quiet,
            };
            foreach (var a in command.Skip(1))
                info.ArgumentList.Add(a);
            using var process = Process.Start(info)!;
            if (quiet)
            {
                process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
            }
            process.WaitForExit();
            return process.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}
