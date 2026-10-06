using System.Diagnostics;
using System.Text.RegularExpressions;

namespace PcManager.Agent.Linux;

/// <summary>
/// 원격조작을 위해 로그인 화면·사용자 세션을 X11(Xorg)로 바꾸고 재부팅한다.
/// Ubuntu 기본 로그인 관리자(GDM)는 Wayland를 쓰는데, Wayland는 화면 캡처·입력 주입을 막는다.
/// GDM 설정 [daemon] WaylandEnable=false → 로그인 화면과 사용자 세션 모두 Xorg
/// </summary>
public static partial class X11Session
{
    private static readonly string[] GdmConfigs = ["/etc/gdm3/custom.conf", "/etc/gdm/custom.conf"];

    /// <returns>오류 메시지. 성공이면 null (잠시 뒤 재부팅)</returns>
    public static string? SwitchAndReboot(ILogger logger)
    {
        if (!Environment.IsPrivilegedProcess)
            return "에이전트가 관리자 권한(서비스)으로 실행 중이 아닙니다.";

        var config = GdmConfigs.FirstOrDefault(File.Exists);
        if (config is null)
        {
            return File.Exists("/usr/sbin/lightdm")
                ? "로그인 관리자가 LightDM입니다 (이미 X11 사용). 로그인 화면의 세션 메뉴에서 Xorg 세션을 고르세요."
                : "GDM 설정 파일(/etc/gdm3/custom.conf)을 찾지 못했습니다. 로그인 화면의 세션 메뉴에서 Xorg 세션을 직접 고르세요.";
        }

        try
        {
            // 처음 바꿀 때의 원래 설정을 남긴다 (되돌리기: 이 파일을 custom.conf로 복사 후 재부팅)
            var backup = config + ".pcmanager.bak";
            if (!File.Exists(backup))
                File.Copy(config, backup);
            File.WriteAllLines(config, DisableWayland(File.ReadAllLines(config)));
            logger.LogInformation("GDM Wayland 끔 ({Config}), 재부팅합니다", config);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return $"설정을 바꾸지 못했습니다 ({config}): {ex.Message}";
        }

        // 서버에 응답이 간 뒤 재부팅되도록 잠시 기다린다
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(3));
            try
            {
                using var reboot = Process.Start("systemctl", "reboot");
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                logger.LogWarning("재부팅 실패: {Message}", ex.Message);
            }
        });
        return null;
    }

    /// <summary>[daemon] 섹션의 WaylandEnable을 false로 (주석이면 풀고, 없으면 추가)</summary>
    internal static List<string> DisableWayland(IEnumerable<string> lines)
    {
        var result = lines.ToList();
        var daemon = result.FindIndex(l => l.Trim().Equals("[daemon]", StringComparison.OrdinalIgnoreCase));
        if (daemon < 0)
        {
            result.InsertRange(0, ["[daemon]", "WaylandEnable=false", ""]);
            return result;
        }
        var end = result.FindIndex(daemon + 1, l => l.TrimStart().StartsWith('['));
        if (end < 0)
            end = result.Count;
        for (var i = daemon + 1; i < end; i++)
        {
            if (WaylandLine().IsMatch(result[i]))
            {
                result[i] = "WaylandEnable=false";
                return result;
            }
        }
        result.Insert(daemon + 1, "WaylandEnable=false");
        return result;
    }

    [GeneratedRegex(@"^\s*#?\s*WaylandEnable\s*=")]
    private static partial Regex WaylandLine();
}
