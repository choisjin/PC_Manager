using System.Text;
using PcManager.Agent.Service;

// cmd 출력(CP949 등 OEM 코드 페이지)을 읽기 위해 필요
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "PcManagerAgent");
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));
builder.Services.AddSingleton<AgentIdentity>();
builder.Services.AddSingleton<OutboundQueue>();
builder.Services.AddSingleton<CommandRunner>();
builder.Services.AddSingleton<FileTransferService>();
builder.Services.AddHostedService<AgentWorker>();

var host = builder.Build();
host.Run();
