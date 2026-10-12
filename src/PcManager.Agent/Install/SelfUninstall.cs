using System.ComponentModel;
using System.Diagnostics;

namespace PcManager.Agent.Install;

/// <summary>
/// 런처(트레이)의 [에이전트 삭제]. 실행 중인 exe는 자기 파일을 지울 수 없으므로 임시 폴더에 복사본을 만들어
/// 그 복사본을 관리자 권한으로 띄우고(--uninstall --purge --cleanup-self) 런처는 바로 끝낸다.
/// 복사본이 서비스·런처·원격조작 프로세스를 끝내고 설치 폴더·설정을 지운 뒤, 창을 닫으면 자기 임시 폴더도 지운다.
/// </summary>
internal static class SelfUninstall
{
    public const string CleanupArgument = "--cleanup-self";
    private const string TempPrefix = "PcManagerUninstall-";

    /// <returns>오류 메시지. 시작했으면 null, 사용자가 관리자 권한 확인(UAC)을 취소했으면 빈 문자열</returns>
    public static string? Start()
    {
        var dir = Path.Combine(Path.GetTempPath(), TempPrefix + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            Directory.CreateDirectory(dir);
            var copy = Path.Combine(dir, Path.GetFileName(Environment.ProcessPath!));
            File.Copy(Environment.ProcessPath!, copy);
            using var process = Process.Start(new ProcessStartInfo(copy, $"--uninstall --purge --elevated {CleanupArgument}")
            {
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = dir,
            });
            return null;
        }
        catch (Win32Exception)
        {
            // UAC 취소
            TryDeleteDirectory(dir);
            return "";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            TryDeleteDirectory(dir);
            return ex.Message;
        }
    }

    /// <summary>제거가 끝난 뒤 임시 복사본 폴더를 지운다. 이 프로세스가 끝난 다음 cmd가 지운다</summary>
    public static void CleanupSelf()
    {
        var dir = Path.GetDirectoryName(Environment.ProcessPath!);
        // 임시 복사본 폴더일 때만 (설치 폴더 등을 지우지 않게)
        if (dir is null || !Path.GetFileName(dir).StartsWith(TempPrefix, StringComparison.Ordinal))
            return;
        try
        {
            using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"{dir}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetTempPath(),
            });
        }
        catch (Exception ex) when (ex is Win32Exception or IOException)
        {
            // 임시 폴더는 Windows 정리 때 지워진다
        }
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
                Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
        }
    }
}
