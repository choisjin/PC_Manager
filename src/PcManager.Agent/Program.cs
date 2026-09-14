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
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        // cmd 출력(CP949 등 OEM 코드 페이지)을 읽기 위해 필요
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        if (AgentHost.IsRunningAsService)
            return AgentHost.Run();

        if (args.Contains("--service") || args.Contains("--console"))
            return AgentHost.Run();

        if (args.Contains("--launcher"))
            return Launcher.LauncherApp.Run(showWindow: !args.Contains("--tray"));

        if (args.Contains("--uninstall"))
            return Install.SetupUI.Uninstall(removeData: args.Contains("--purge"));

        // 기본: 설치 프로그램
        return Install.SetupUI.Install();
    }
}
