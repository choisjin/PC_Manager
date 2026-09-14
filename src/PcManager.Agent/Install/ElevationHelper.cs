using System.Diagnostics;
using System.Security.Principal;

namespace PcManager.Agent.Install;

internal static class ElevationHelper
{
    public static bool IsElevated
    {
        get
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    /// <summary>관리자 권한으로 자기 자신을 다시 실행한다 (UAC 창). 사용자가 거부하면 false.</summary>
    public static bool TryRelaunchElevated(string arguments, out int exitCode)
    {
        exitCode = 0;
        var startInfo = new ProcessStartInfo
        {
            FileName = Environment.ProcessPath!,
            Arguments = arguments,
            UseShellExecute = true,
            Verb = "runas",
        };
        try
        {
            using var process = Process.Start(startInfo);
            if (process is null)
                return false;
            process.WaitForExit();
            exitCode = process.ExitCode;
            return true;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // 사용자가 UAC에서 취소함
            return false;
        }
    }
}
