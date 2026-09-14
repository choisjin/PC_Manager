using System.Text;
using Microsoft.Extensions.Hosting.WindowsServices;
using PcManager.Agent.Service;

// cmd 출력(CP949 등 OEM 코드 페이지)을 읽기 위해 필요
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    Args = args,
    // 서비스로 실행되면 작업 폴더가 System32라서 실행 파일 폴더를 기준으로 삼는다
    ContentRootPath = WindowsServiceHelpers.IsWindowsService() ? AppContext.BaseDirectory : null,
});
builder.Services.AddWindowsService(o => o.ServiceName = "PcManagerAgent");

// 설치 스크립트가 만든 설정 파일 (서버 주소, 토큰, 태그). 업그레이드해도 유지된다
builder.Configuration.AddJsonFile(AgentOptions.InstalledConfigPath, optional: true, reloadOnChange: false);
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));
builder.Services.AddSingleton<AgentIdentity>();
builder.Services.AddSingleton<OutboundQueue>();
builder.Services.AddSingleton<CommandRunner>();
builder.Services.AddSingleton<FileTransferService>();
builder.Services.AddHostedService<AgentWorker>();

var host = builder.Build();
host.Run();
