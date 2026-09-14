using System.Diagnostics;
using System.ServiceProcess;

namespace PcManager.Agent.Install;

/// <summary>
/// 에이전트를 Program Files에 복사하고 Windows 서비스로 등록/제거한다.
/// sc.exe를 직접 호출해 별도 도구 없이 동작한다.
/// </summary>
internal static class ServiceInstaller
{
    public static string InstallDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PcManager", "Agent");

    public static string InstalledExePath => Path.Combine(InstallDir, "PcManager.Agent.exe");

    public static void Install(Action<string> log)
    {
        var sourceExe = Environment.ProcessPath!;
        StopServiceIfRunning(log);

        log($"파일 복사: {InstallDir}");
        Directory.CreateDirectory(InstallDir);
        CopyWithRetry(sourceExe, InstalledExePath);

        if (ServiceExists())
        {
            // 이미 있으면 실행 파일 경로만 갱신 (업그레이드)
            Run("sc.exe", $"config {AgentHost.ServiceName} binPath= \"{InstalledExePath}\"");
        }
        else
        {
            log("서비스 등록");
            Run("sc.exe", $"create {AgentHost.ServiceName} binPath= \"{InstalledExePath}\" start= auto " +
                $"DisplayName= \"PC Manager Agent\"");
            Run("sc.exe", $"description {AgentHost.ServiceName} \"PC Manager 테스트 PC 에이전트 - 원격 명령, Job, 파일 전송을 처리합니다.\"");
        }

        // 부팅 후 네트워크 준비 뒤 시작, 비정상 종료 시 자동 재시작
        Run("sc.exe", $"config {AgentHost.ServiceName} start= delayed-auto");
        Run("sc.exe", $"failure {AgentHost.ServiceName} reset= 86400 actions= restart/5000/restart/5000/restart/5000");

        CreateStartMenuShortcut(log);

        log("서비스 시작");
        Run("sc.exe", $"start {AgentHost.ServiceName}", allowFailure: true);
    }

    private static string StartMenuShortcutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs", "PC Manager 에이전트.lnk");

    /// <summary>런처를 다시 열 수 있게 시작 메뉴 바로가기를 만든다 ([에이전트 종료] 후 재시작용).</summary>
    private static void CreateStartMenuShortcut(Action<string> log)
    {
        try
        {
            var script =
                "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:PCM_LNK); " +
                "$s.TargetPath = $env:PCM_EXE; $s.Arguments = '--launcher'; " +
                "$s.WorkingDirectory = Split-Path $env:PCM_EXE; $s.Description = 'PC Manager 에이전트'; $s.Save()";
            var startInfo = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-ExecutionPolicy");
            startInfo.ArgumentList.Add("Bypass");
            startInfo.ArgumentList.Add("-Command");
            startInfo.ArgumentList.Add(script);
            startInfo.Environment["PCM_LNK"] = StartMenuShortcutPath;
            startInfo.Environment["PCM_EXE"] = InstalledExePath;

            using var process = Process.Start(startInfo)!;
            process.WaitForExit(TimeSpan.FromSeconds(20));
        }
        catch (Exception ex)
        {
            // 바로가기 실패는 설치를 막지 않는다
            log($"경고: 시작 메뉴 바로가기 생성 실패: {ex.Message}");
        }
    }

    public static void Uninstall(bool removeData, Action<string> log)
    {
        StopServiceIfRunning(log);
        if (ServiceExists())
        {
            log("서비스 삭제");
            Run("sc.exe", $"delete {AgentHost.ServiceName}", allowFailure: true);
        }

        try
        {
            if (File.Exists(StartMenuShortcutPath))
                File.Delete(StartMenuShortcutPath);
        }
        catch (IOException)
        {
            // 무시
        }

        // 실행 파일은 지금 실행 중일 수 있어(Program Files에서 실행된 경우) 재부팅 후 정리하도록 남긴다
        if (!string.Equals(Environment.ProcessPath, InstalledExePath, StringComparison.OrdinalIgnoreCase)
            && Directory.Exists(InstallDir))
        {
            TryDeleteDirectory(InstallDir, log);
        }

        if (removeData && Directory.Exists(AgentOptions.DefaultDataDirectory))
        {
            log("설정/데이터 삭제");
            TryDeleteDirectory(AgentOptions.DefaultDataDirectory, log);
        }
    }

    public static bool ServiceExists() =>
        ServiceController.GetServices().Any(s => s.ServiceName == AgentHost.ServiceName);

    private static void StopServiceIfRunning(Action<string> log)
    {
        if (!ServiceExists())
            return;
        using var service = new ServiceController(AgentHost.ServiceName);
        if (service.Status == ServiceControllerStatus.Stopped)
            return;

        log("기존 서비스 중지");
        try
        {
            service.Stop();
            service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
        }
        catch (System.ServiceProcess.TimeoutException)
        {
            log("경고: 서비스가 제때 멈추지 않았습니다.");
        }
        catch (InvalidOperationException)
        {
            // 멈출 수 없는 상태 → 그냥 진행
        }
    }

    private static void CopyWithRetry(string source, string destination)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                File.Copy(source, destination, overwrite: true);
                return;
            }
            catch (IOException) when (attempt < 10)
            {
                Thread.Sleep(1000);
            }
        }
    }

    private static void TryDeleteDirectory(string path, Action<string> log)
    {
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                Directory.Delete(path, recursive: true);
                return;
            }
            catch (IOException) when (attempt < 5)
            {
                Thread.Sleep(1000);
            }
            catch (UnauthorizedAccessException)
            {
                log($"경고: 일부 파일을 삭제하지 못했습니다: {path}");
                return;
            }
        }
    }

    private static void Run(string fileName, string arguments, bool allowFailure = false)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0 && !allowFailure)
            throw new InvalidOperationException($"{fileName} {arguments}\n{stdout}{stderr}".Trim());
    }
}
