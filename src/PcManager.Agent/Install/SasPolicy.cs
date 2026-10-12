using Microsoft.Win32;

namespace PcManager.Agent.Install;

/// <summary>
/// Ctrl+Alt+Del 전송에 필요한 "소프트웨어 SAS 생성" 정책(SoftwareSASGeneration). 에이전트가 켤 때 원래 값을 기억해 두고,
/// 에이전트를 지울 때 원래대로 되돌린다 (원래 켜져 있었으면 그대로 둔다).
/// </summary>
internal static class SasPolicy
{
    public const string KeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    public const string ValueName = "SoftwareSASGeneration";
    private const string Absent = "absent";

    // 원래 값 기록 (설정 폴더 안. 제거 때 설정을 지우기 전에 되돌린다)
    private static string MarkerPath => Path.Combine(AgentOptions.DefaultDataDirectory, "sas-policy.txt");

    /// <summary>정책을 바꾸기 직전에 원래 값을 기억한다 (처음 한 번만)</summary>
    public static void RememberOriginal(int? original)
    {
        try
        {
            if (File.Exists(MarkerPath))
                return;
            Directory.CreateDirectory(AgentOptions.DefaultDataDirectory);
            File.WriteAllText(MarkerPath, original?.ToString() ?? Absent);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 기록하지 못하면 제거 때 그대로 둔다
        }
    }

    /// <summary>에이전트가 바꾼 정책을 원래 값으로 되돌린다. 기록이 없으면(에이전트가 바꾸지 않았음) 그대로 둔다</summary>
    public static void Restore(Action<string> log)
    {
        if (!File.Exists(MarkerPath))
            return;
        try
        {
            var original = File.ReadAllText(MarkerPath).Trim();
            using var key = Registry.LocalMachine.OpenSubKey(KeyPath, writable: true);
            if (key is not null)
            {
                if (original == Absent)
                    key.DeleteValue(ValueName, throwOnMissingValue: false);
                else if (int.TryParse(original, out var value))
                    key.SetValue(ValueName, value, RegistryValueKind.DWord);
                log("Ctrl+Alt+Del 정책 되돌림");
            }
            File.Delete(MarkerPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            log($"경고: Ctrl+Alt+Del 정책을 되돌리지 못했습니다: {ex.Message}");
        }
    }
}
