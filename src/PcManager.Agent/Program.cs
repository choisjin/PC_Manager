using System.Text;

namespace PcManager.Agent;

internal static class Program
{
    /// <summary>
    /// 실행 모드 (인자로 구분, 기본은 설치 프로그램):
    ///   (없음)      더블클릭 설치 (필요하면 UAC로 관리자 승격)
    ///   --uninstall 제거 (--purge: 설정/데이터까지)
    ///   --service   Windows 서비스 본체 (SCM이 실행)
    ///   --console   개발용 콘솔 서비스
    ///   --launcher  트레이 런처 (--tray: 창을 열지 않고 트레이만)
    ///   --remote-session &lt;url&gt; 원격조작 프로세스 (서비스가 사용자 세션에 띄움)
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        // cmd 출력(CP949 등 OEM 코드 페이지)을 읽기 위해 필요
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        // 서비스가 띄운 자식 프로세스라 서비스 판별보다 먼저 확인한다
        var remoteIndex = Array.IndexOf(args, Remote.RemoteControlService.SessionArgument);
        if (remoteIndex >= 0 && remoteIndex + 1 < args.Length)
            return Remote.RemoteSessionApp.Run(args[remoteIndex + 1], thumbnail: args.Contains(Remote.RemoteControlService.ThumbnailArgument));

        // 서비스가 사용자 세션에 띄우는 클립보드 도우미: --set-clipboard-files <경로 목록 파일>
        var clipIndex = Array.IndexOf(args, ClipboardHandoff.HelperArgument);
        if (clipIndex >= 0 && clipIndex + 1 < args.Length)
            return ClipboardHandoff.RunHelper(args[clipIndex + 1]);

        // 서비스가 사용자 세션에 띄우는 아이콘 도우미: --shell-icons <결과 파일> <확장자:크기,...>
        var iconIndex = Array.IndexOf(args, UserShellIcons.HelperArgument);
        if (iconIndex >= 0 && iconIndex + 2 < args.Length)
            return UserShellIcons.RunHelper(args[iconIndex + 1], args[iconIndex + 2]);

        if (AgentHost.IsRunningAsService)
            return AgentHost.Run();

        if (args.Contains("--service") || args.Contains("--console"))
            return AgentHost.Run();

        if (args.Contains("--launcher"))
            return Launcher.LauncherApp.Run(showWindow: !args.Contains("--tray"));

        if (args.Contains("--uninstall"))
            return Install.SetupUI.Uninstall(removeData: args.Contains("--purge"));

        // 런처에서 멈춘 서비스를 다시 시작 (관리자 승격)
        if (args.Contains("--start-service"))
            return Install.ServiceControl.StartService();

        // 서버가 트리거하는 자가 업데이트: 창 없이 설치 (SYSTEM 권한 전제)
        if (args.Contains("--install") && args.Contains("--silent"))
            return Install.SetupUI.InstallSilent();

        // 기본: 설치 프로그램 (더블클릭)
        return Install.SetupUI.Install();
    }
}
