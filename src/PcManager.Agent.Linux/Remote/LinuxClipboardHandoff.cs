using System.Diagnostics;

namespace PcManager.Agent.Linux.Remote;

/// <summary>
/// 이 PC에서 대시보드를 열었을 때: 원격 PC에서 복사한 파일을 받아 둘 폴더를 만들고, 받은 파일을 X 클립보드에 넣는다
/// (서비스는 root라 화면 세션 환경 DISPLAY·XAUTHORITY로 xclip을 띄운다)
/// </summary>
public static class LinuxClipboardHandoff
{
    public static string Prepare()
    {
        var folder = Path.Combine(RemoteSession.ClipboardFolder, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }

    /// <returns>오류 메시지. 성공이면 null</returns>
    public static string? SetFiles(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0)
            return "붙여넣을 파일이 없습니다.";
        var display = DisplayLocator.Find();
        if (display is null)
            return "화면(X11 데스크톱 세션)을 찾지 못했습니다.";
        var info = new ProcessStartInfo("xclip")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
        };
        foreach (var a in new[] { "-selection", "clipboard", "-t", RemoteSession.GnomeFilesTarget, "-i" })
            info.ArgumentList.Add(a);
        info.Environment["DISPLAY"] = display.Display;
        if (display.XAuthority is not null)
            info.Environment["XAUTHORITY"] = display.XAuthority;
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return "xclip을 실행하지 못했습니다.";
            // xclip은 내용을 읽은 뒤 백그라운드로 남아 클립보드를 제공한다
            process.StandardInput.Write("copy\n" + string.Join('\n', paths.Select(p => new Uri(p).AbsoluteUri)));
            process.StandardInput.Close();
            process.WaitForExit(3000);
            return null;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return "xclip이 없습니다: sudo apt install xclip";
        }
    }
}
