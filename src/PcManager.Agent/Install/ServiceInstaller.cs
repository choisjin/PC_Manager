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
        // 같은 exe로 떠 있는 런처·원격조작·썸네일 프로세스가 파일을 잡고 있으면 덮어쓸 수 없다
        KillOtherInstances(log);

        log($"파일 복사: {InstallDir}");
        Directory.CreateDirectory(InstallDir);
        CleanupOldExe();
        CopyWithRetry(sourceExe, InstalledExePath, log);

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
        KillOtherInstances(log);
        // 원격조작이 설치했을 수 있는 가상 모니터 드라이버도 함께 제거 (best-effort)
        try
        {
            Remote.VirtualDisplay.Uninstall(log);
        }
        catch (Exception ex)
        {
            log($"가상 모니터 드라이버 제거 실패 (무시): {ex.Message}");
        }
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

    private static string OldExePath => InstalledExePath + ".old";

    /// <summary>설치된 exe로 실행 중인 다른 프로세스(런처 --launcher, 원격조작/썸네일 --remote-session)를 끝낸다. 서비스가 다시 뜨면 런처는 자동으로 다시 실행된다</summary>
    private static void KillOtherInstances(Action<string> log)
    {
        var self = Environment.ProcessId;
        var killed = 0;
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(InstalledExePath)))
        {
            using (process)
            {
                if (process.Id == self)
                    continue;
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                    killed++;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    log($"경고: 프로세스 {process.Id} 종료 실패: {ex.Message}");
                }
            }
        }
        if (killed > 0)
            log($"실행 중이던 에이전트 프로세스 {killed}개 종료");
    }

    private static void CleanupOldExe()
    {
        try
        {
            if (File.Exists(OldExePath))
                File.Delete(OldExePath);
        }
        catch (IOException)
        {
            // 아직 쓰는 중이면 다음 설치 때 지운다
        }
        catch (UnauthorizedAccessException)
        {
            // 위와 같음
        }
    }

    private static void CopyWithRetry(string source, string destination, Action<string> log)
    {
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                File.Copy(source, destination, overwrite: true);
                return;
            }
            catch (IOException) when (attempt < 5)
            {
                Thread.Sleep(1000);
            }
            catch (IOException)
            {
                // 그래도 잠겨 있으면(실행 중인 이미지) 이름만 바꿔 두고 새 파일을 놓는다. 실행 중인 exe도 이름 변경은 된다
                log("기존 파일이 잠겨 있어 .old로 바꾸고 복사합니다");
                CleanupOldExe();
                File.Move(destination, OldExePath, overwrite: true);
                File.Copy(source, destination, overwrite: true);
                return;
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
