using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Options;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>PC 고유 ID(최초 실행 시 생성해 저장)와 시스템 정보를 제공한다.</summary>
public class AgentIdentity(IOptions<AgentOptions> options, AgentSettingsStore settings)
{
    public string AgentId { get; } = LoadOrCreateId(options.Value.DataDirectory);

    public AgentInfo CreateInfo()
    {
        // 게이트웨이가 있는 어댑터(실제 LAN)를 앞에 둔다
        var interfaces = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up
                && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .OrderByDescending(n => n.GetIPProperties().GatewayAddresses.Count > 0)
            .ToList();

        var ipAddresses = interfaces
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
            .Select(a => a.Address.ToString())
            .Distinct()
            .ToList();

        var macAddresses = interfaces
            .Select(n => n.GetPhysicalAddress().GetAddressBytes())
            .Where(bytes => bytes.Length == 6)
            .Select(bytes => string.Join("-", bytes.Select(b => b.ToString("X2"))))
            .Distinct()
            .ToList();

        return new AgentInfo(
            AgentId,
            Environment.MachineName,
            RuntimeInformation.OSDescription,
            AgentStatusTracker.AgentVersionText,
            Environment.UserName,
            ipAddresses,
            macAddresses,
            settings.Current.Tags);
    }

    private static string LoadOrCreateId(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        var path = Path.Combine(dataDirectory, "agent-id");
        if (File.Exists(path))
        {
            var saved = File.ReadAllText(path).Trim();
            if (Guid.TryParseExact(saved, "N", out _))
                return saved;
        }

        var id = Guid.NewGuid().ToString("N");
        File.WriteAllText(path, id);
        return id;
    }
}
