using System.Text;
using PcManager.Agent;
using PcManager.Agent.Linux;
using PcManager.Agent.Linux.Remote;

// 실행 모드 (인자로 구분):
//   --service                 systemd 서비스 본체 (설치하면 이걸로 등록)
//   --console [--server URL]  개발·시험용 (설정 파일 대신 --server)
//   --install [--server URL]  설치: /opt/pcmanager-agent + systemd 서비스 등록·시작 (root 필요)
//   --uninstall [--purge]     제거 (--purge: 설정·데이터까지)
//   --set-server URL          서버 주소 변경 후 서비스 재시작 (root 필요)
//   --remote-session URL [--thumb]  원격조작/썸네일 도우미 (서비스가 X11 세션 환경으로 띄움)
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

string? Arg(string name)
{
    var i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

if (Arg(LinuxRemoteControl.SessionArgument) is { } remoteUrl)
    return RemoteSessionApp.Run(remoteUrl, thumbnail: args.Contains(LinuxRemoteControl.ThumbnailArgument));

if (args.Contains("--install"))
    return SystemdInstaller.Install(ServerInfoClient.NormalizeServerUrl(Arg("--server")));

if (args.Contains("--uninstall"))
    return SystemdInstaller.Uninstall(purge: args.Contains("--purge"));

if (Arg("--set-server") is { } newServer)
    return SystemdInstaller.SetServer(ServerInfoClient.NormalizeServerUrl(newServer));

if (args.Contains("--service") || args.Contains("--console"))
    return LinuxAgentHost.Run(ServerInfoClient.NormalizeServerUrl(Arg("--server")));

Console.WriteLine($"""
    PC Manager Linux 에이전트 {AgentStatusTracker.AgentVersionText}

      sudo ./pcmanager-agent --install --server http://서버주소:포트   설치 (서비스 등록·시작)
      sudo pcmanager-agent --set-server http://서버주소:포트          서버 주소 변경
      sudo pcmanager-agent --uninstall [--purge]                     제거
      pcmanager-agent --console --server http://서버주소:포트        설치 없이 실행 (시험용)
    """);
return 1;
