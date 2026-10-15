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
        // 원격조작이 설치했을 수 있는 가상 모니터 드라이버(인증서 포함)도 함께 제거 (best-effort)
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
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
        }

        // Ctrl+Alt+Del 정책은 설정 폴더의 기록을 보고 되돌리므로 설정을 지우기 전에
        SasPolicy.Restore(log);

        // 프로그램 폴더 (Program Files에서 실행 중이면 지금은 못 지우므로 재부팅 때 지우도록 예약)
        if (Directory.Exists(InstallDir))
        {
            log($"프로그램 삭제: {InstallDir}");
            TryDeleteDirectory(InstallDir, log);
        }
        DeleteIfEmpty(Path.GetDirectoryName(InstallDir)!);

        // 원격조작이 쓰던 공용 폴더·임시 파일
        TryDeleteDirectory(Remote.RemoteSessionApp.ClipboardFolder, log);
        foreach (var temp in SystemTempFolders())
        {
            TryDeleteFile(Path.Combine(temp, "PcManagerRemote.log"));
            TryDeleteDirectory(Path.Combine(temp, "PcManagerUpdate"), log);
        }
        foreach (var profile in UserProfiles())
        {
            var temp = Path.Combine(profile, "AppData", "Local", "Temp");
            TryDeleteDirectory(Path.Combine(temp, "PcManagerIcons"), log);
            // 원격조작 클립보드 도우미가 남긴 파일 (감시 결과 · 읽기 결과)
            try
            {
                if (Directory.Exists(temp))
                {
                    foreach (var file in Directory.EnumerateFiles(temp, "PcManagerClip*.*"))
                        TryDeleteFile(file);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 남아도 무방
            }
        }

        if (removeData)
        {
            if (Directory.Exists(AgentOptions.DefaultDataDirectory))
            {
                log("설정/데이터 삭제");
                TryDeleteDirectory(AgentOptions.DefaultDataDirectory, log);
            }
            DeleteIfEmpty(Path.GetDirectoryName(AgentOptions.DefaultDataDirectory)!);
            // 내 PC에서 열어 편집하던 파일의 작업 사본 (편집한 내용은 이미 원래 PC에 저장됨)
            foreach (var profile in UserProfiles())
                TryDeleteDirectory(Path.Combine(profile, "Documents", "PC Manager 편집"), log);
        }
    }

    /// <summary>SYSTEM 계정(서비스·원격조작 프로세스)이 쓰는 임시 폴더</summary>
    private static IEnumerable<string> SystemTempFolders()
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        yield return Path.Combine(windows, "Temp");
        yield return Path.Combine(windows, "SystemTemp");
    }

    /// <summary>이 PC 사용자 프로필 폴더들 (C:\Users\*)</summary>
    private static IEnumerable<string> UserProfiles()
    {
        var root = Path.GetDirectoryName(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        if (root is null || !Directory.Exists(root))
            return [];
        try
        {
            return Directory.GetDirectories(root);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static void DeleteIfEmpty(string dir)
    {
        try
        {
            if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
                Directory.Delete(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
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
                    try
                    {
                        process.Kill(entireProcessTree: true);
                    }
                    catch (InvalidOperationException) when (!process.HasExited)
                    {
                        // 이 제거 프로그램을 띄운 런처(부모)면 트리 전체 종료가 거부된다 → 그 프로세스만
                        process.Kill();
                    }
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
        if (!Directory.Exists(path))
            return;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                Directory.Delete(path, recursive: true);
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 방금 끝낸 프로세스가 파일을 놓을 때까지 잠깐 기다린다
                Thread.Sleep(1000);
            }
        }

        // 그래도 잠긴 파일(실행 중인 exe 등)은 재부팅 때 지우도록 예약한다
        var pending = 0;
        try
        {
            foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
            {
                try
                {
                    File.Delete(file);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    if (MoveFileEx(file, null, MOVEFILE_DELAY_UNTIL_REBOOT))
                        pending++;
                }
            }
            // 폴더는 깊은 곳부터 (안의 파일이 먼저 지워져야 하므로 재부팅 예약도 같은 순서)
            foreach (var dir in Directory.EnumerateDirectories(path, "*", SearchOption.AllDirectories).OrderByDescending(d => d.Length).Append(path))
            {
                try
                {
                    Directory.Delete(dir);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    MoveFileEx(dir, null, MOVEFILE_DELAY_UNTIL_REBOOT);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 아래 안내
        }
        if (Directory.Exists(path))
            log(pending > 0
                ? $"사용 중인 파일 {pending}개는 재부팅하면 삭제됩니다: {path}"
                : $"경고: 일부 파일을 삭제하지 못했습니다: {path}");
    }

    private const int MOVEFILE_DELAY_UNTIL_REBOOT = 0x4;

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingFileName, string? newFileName, int flags);

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
