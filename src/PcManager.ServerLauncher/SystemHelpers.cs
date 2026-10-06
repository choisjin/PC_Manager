using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Microsoft.Win32;

namespace PcManager.ServerLauncher;

/// <summary>인바운드 방화벽 규칙 (관리자 권한 필요 → netsh를 승격 실행, UAC 한 번)</summary>
internal static class Firewall
{
    public static string RuleName(string instanceName) => $"PC Manager Server ({instanceName})";

    public static bool TryOpen(string instanceName, IEnumerable<int> ports, out string? error)
    {
        // 같은 이름 규칙을 지우고 다시 만든다 (포트가 바뀐 경우)
        var name = RuleName(instanceName);
        return RunElevated(
            $"/c netsh advfirewall firewall delete rule name=\"{name}\" >nul & " +
            $"netsh advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol=TCP localport={string.Join(',', ports)}",
            out error);
    }

    public static bool TryRemove(string instanceName, out string? error) =>
        RunElevated($"/c netsh advfirewall firewall delete rule name=\"{RuleName(instanceName)}\"", out error);

    private static bool RunElevated(string cmdArguments, out string? error)
    {
        error = null;
        try
        {
            using var process = Process.Start(new ProcessStartInfo("cmd.exe", cmdArguments)
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            process?.WaitForExit(30_000);
            return true;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            error = "관리자 승인이 취소됐습니다.";
            return false;
        }
        catch (Win32Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }
}

/// <summary>Windows 로그인 시 런처 자동 실행 (현재 사용자 Run 키)</summary>
internal static class Autorun
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "PcManagerServerLauncher";
    public const string MinimizedArgument = "--minimized";

    private static string Command => $"\"{Environment.ProcessPath}\" {MinimizedArgument}";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return string.Equals(key?.GetValue(ValueName) as string, Command, StringComparison.OrdinalIgnoreCase);
        }
    }

    public static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled)
            key.SetValue(ValueName, Command);
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

internal static class NetInfo
{
    /// <summary>에이전트에 알려 줄 이 PC의 내부 IP (UDP connect는 패킷을 보내지 않음)</summary>
    public static string LanAddress()
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect("10.255.255.255", 1);
            if (socket.LocalEndPoint is IPEndPoint { Address: var address } && !IPAddress.IsLoopback(address))
                return address.ToString();
        }
        catch (SocketException)
        {
        }
        return Environment.MachineName;
    }
}
