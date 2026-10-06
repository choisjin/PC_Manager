using System.Security.Cryptography;
using System.Text;

namespace PcManager.ServerLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // 같은 폴더(같은 launcher.json)의 런처는 하나만. 다른 폴더에 둔 런처는 따로 돌 수 있다
        var rootHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(LauncherPaths.Root.ToUpperInvariant())))[..16];
        using var mutex = new Mutex(true, $"Local\\PcManagerServerLauncher-{rootHash}", out var first);

        ApplicationConfiguration.Initialize();
        if (!first)
        {
            MessageBox.Show("이 폴더의 서버 런처가 이미 실행 중입니다. 작업 표시줄 트레이 아이콘을 확인하세요.",
                "PC Manager 서버 런처", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        try
        {
            Directory.CreateDirectory(LauncherPaths.InstancesDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            MessageBox.Show($"런처 폴더에 쓸 수 없습니다: {LauncherPaths.Root}\n쓰기 가능한 폴더(예: D:\\PcManagerServers)로 옮겨 실행하세요.\n\n{ex.Message}",
                "PC Manager 서버 런처", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Application.Run(new MainForm(args.Contains(Autorun.MinimizedArgument, StringComparer.OrdinalIgnoreCase)));
    }
}
