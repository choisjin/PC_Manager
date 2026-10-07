using System.Text;
using PcManager.Agent.Remote;
using PcManager.Agent.Service;

namespace PcManager.Agent;

/// <summary>
/// 대시보드를 연 PC(내 PC)로 원격 PC에서 복사한 파일을 넘길 때: 받아 둘 폴더를 만들고, 받은 파일을 사용자 클립보드에 넣는다.
/// 서비스는 SYSTEM(세션 0)이라 사용자 클립보드에 닿지 않으므로 사용자 세션에 도우미(--set-clipboard-files)를 잠깐 띄운다
/// </summary>
public static class ClipboardHandoff
{
    public const string HelperArgument = "--set-clipboard-files";

    /// <summary>() → 새 받을 폴더 (공용 폴더 아래, 사용자가 읽을 수 있음)</summary>
    public static string Prepare()
    {
        var folder = Path.Combine(RemoteSessionApp.ClipboardFolder, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }

    /// <returns>오류 메시지. 성공이면 null</returns>
    public static string? SetFiles(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0)
            return "붙여넣을 파일이 없습니다.";
        try
        {
            if (!AgentHost.IsRunningAsService)
                return RemoteClipboard.SetFiles(paths) ? null : "클립보드에 넣지 못했습니다.";

            var session = SessionProcess.GetInteractiveUserSessionId();
            if (session is null)
                return "로그인한 사용자가 없습니다.";
            Directory.CreateDirectory(RemoteSessionApp.ClipboardFolder);
            var list = Path.Combine(RemoteSessionApp.ClipboardFolder, $"{Guid.NewGuid():N}.txt");
            File.WriteAllLines(list, paths, new UTF8Encoding(false));
            try
            {
                var exit = SessionProcess.StartAsSessionUser(session.Value, Environment.ProcessPath!, $"{HelperArgument} \"{list}\"", waitMilliseconds: 10_000);
                return exit == 0 ? null : "클립보드에 넣지 못했습니다" + (exit is null ? " (시간 초과)." : $" (코드 {exit}).");
            }
            finally
            {
                File.Delete(list);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return "클립보드에 넣지 못했습니다: " + ex.Message;
        }
    }

    /// <summary>사용자 세션 도우미: 목록 파일의 경로들을 클립보드에 넣고 끝낸다 (넣은 내용은 프로세스가 끝나도 남는다)</summary>
    public static int RunHelper(string listFile)
    {
        try
        {
            var paths = File.ReadAllLines(listFile, Encoding.UTF8).Where(p => p.Length > 0).ToList();
            // 다른 프로그램이 잠깐 클립보드를 열고 있을 수 있어 몇 번 다시 시도
            for (var attempt = 0; attempt < 10; attempt++)
            {
                if (RemoteClipboard.SetFiles(paths))
                    return 0;
                Thread.Sleep(100);
            }
            return 2;
        }
        catch (IOException)
        {
            return 1;
        }
    }
}
