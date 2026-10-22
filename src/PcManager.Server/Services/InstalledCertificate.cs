using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 설치형 서버(서비스)의 HTTPS 자체 서명 인증서 (LocalMachine\My, 설치 스크립트가 처음 만든다).
/// 서버 PC의 IP가 바뀌어 인증서에 지금 IP가 없으면 새로 만들어 재시작 없이 바꿔 끼우고,
/// 공개 인증서(.cer)를 다시 내보내고 이 PC 신뢰 저장소에 넣는다. 에이전트 PC는 다시 연결될 때 자동으로 신뢰한다.
/// 설정의 서버 주소·HTTPS 주소가 이 PC의 옛 IP였으면 새 IP로 바꿔 저장한다 (프록시 주소 등 다른 주소는 그대로).
/// </summary>
public sealed class InstalledCertificate(ServerOptions options, StoreLocation location, string exportPath, string configPath)
{
    private const string FriendlyName = "PC Manager Server (self-signed)";

    private readonly Lock _lock = new();
    private volatile X509Certificate2? _current;

    /// <summary>Kestrel이 새 연결마다 쓰는 인증서</summary>
    public X509Certificate2? Current => _current;

    /// <summary>
    /// 인증서가 없거나 곧 만료되거나 지금 가진 IP·PC 이름 중 하나라도 빠져 있으면 새로 만든다. 네트워크가 아직 안 잡혔으면(주 IP 없음) 그대로 둔다.
    /// </summary>
    /// <returns>바꾼 내용 (로그용). 바꾼 게 없으면 null</returns>
    public string? Ensure()
    {
        lock (_lock)
        {
            using var my = new X509Store(StoreName.My, location);
            my.Open(OpenFlags.ReadWrite);
            var existing = my.Certificates.Find(X509FindType.FindBySubjectDistinguishedName, CertificateTrust.ServerSubject, validOnly: false)
                .OrderByDescending(c => c.NotAfter)
                .FirstOrDefault();
            _current ??= existing;

            var primary = PrimaryAddress();
            if (primary is null)
                return null;
            var names = HostNames();
            var ips = LocalAddresses();
            var oldIps = existing is null ? [] : SanAddresses(existing);
            var changes = new List<string>();

            // 지금 가진 IP가 모두 들어 있어야 한다 (네트워크 카드가 둘인 PC는 사람마다 다른 IP로 연다). 없어진 IP는 남아 있어도 된다
            if (existing is null || existing.NotAfter < DateTime.Now.AddDays(30) || !Covers(existing, names, ips))
            {
                var created = Create(names, [.. ips, IPAddress.Loopback]);
                foreach (var old in my.Certificates.Find(X509FindType.FindBySubjectDistinguishedName, CertificateTrust.ServerSubject, validOnly: false))
                    my.Remove(old);
                my.Add(created);
                File.WriteAllBytes(exportPath, created.Export(X509ContentType.Cert));
                if (location == StoreLocation.LocalMachine)
                    CertificateTrust.EnsureTrustedRoot(created);
                _current = created;
                changes.Add($"HTTPS 인증서를 새로 만들었습니다 ({primary}, {created.Thumbprint})");
            }

            // 이 PC의 옛 IP(이전 인증서에 있던 IP)로 적힌 주소만 바꾼다
            var publicUrl = Rehost(options.PublicUrl, oldIps, ips, primary);
            var dashboardUrl = Rehost(options.DashboardHttpsUrl, oldIps, ips, primary);
            if (publicUrl != options.PublicUrl || dashboardUrl != options.DashboardHttpsUrl)
            {
                options.PublicUrl = publicUrl;
                options.DashboardHttpsUrl = dashboardUrl;
                SaveUrls(publicUrl, dashboardUrl);
                changes.Add($"이 PC의 옛 IP로 적힌 주소를 바꿨습니다 (서버 {publicUrl}, HTTPS {dashboardUrl})");
            }
            return changes.Count > 0 ? string.Join(" / ", changes) : null;
        }
    }

    private static X509Certificate2 Create(IReadOnlyList<string> names, IReadOnlyList<IPAddress> ips)
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(CertificateTrust.ServerSubject, rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        foreach (var name in names)
            san.AddDnsName(name);
        foreach (var ip in ips.Distinct())
            san.AddIpAddress(ip);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, critical: true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], critical: false));
        using var ephemeral = request.CreateSelfSigned(DateTimeOffset.Now.AddDays(-1), DateTimeOffset.Now.AddYears(10));
        // 저장소에 넣어 재시작 뒤에도 Kestrel이 찾도록 개인 키를 컴퓨터 키로 저장한다
        var created = X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pfx), password: null,
            X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.PersistKeySet);
        if (OperatingSystem.IsWindows())
            created.FriendlyName = FriendlyName;
        return created;
    }

    private static bool Covers(X509Certificate2 certificate, IReadOnlyList<string> names, IReadOnlyList<IPAddress> ips)
    {
        var ext = certificate.Extensions.OfType<X509SubjectAlternativeNameExtension>().FirstOrDefault();
        if (ext is null)
            return false;
        var dns = ext.EnumerateDnsNames().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var addresses = ext.EnumerateIPAddresses().ToHashSet();
        return names.All(dns.Contains) && ips.All(addresses.Contains);
    }

    private static HashSet<IPAddress> SanAddresses(X509Certificate2 certificate) =>
        certificate.Extensions.OfType<X509SubjectAlternativeNameExtension>().FirstOrDefault()?.EnumerateIPAddresses().ToHashSet() ?? [];

    /// <summary>주소의 호스트가 이 PC의 옛 IP(지금은 없는)면 주 IP로 바꾼다</summary>
    private static string? Rehost(string? url, HashSet<IPAddress> oldIps, IReadOnlyList<IPAddress> ips, IPAddress primary)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || !IPAddress.TryParse(uri.Host, out var host) || IPAddress.IsLoopback(host)
            || !oldIps.Contains(host) || ips.Contains(host))
        {
            return url;
        }
        return new UriBuilder(uri) { Host = primary.ToString() }.Uri.GetLeftPart(UriPartial.Authority);
    }

    private void SaveUrls(string? publicUrl, string? dashboardUrl)
    {
        if (!File.Exists(configPath))
            return;
        var root = JsonNode.Parse(File.ReadAllText(configPath)) as JsonObject ?? [];
        if (root["Server"] is not JsonObject server)
            root["Server"] = server = [];
        server["PublicUrl"] = publicUrl;
        server["DashboardHttpsUrl"] = dashboardUrl;
        // 같은 파일에 덮어써 설치 스크립트가 걸어 둔 권한(ACL)을 유지한다
        File.WriteAllText(configPath, root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }

    private static List<string> HostNames()
    {
        var names = new List<string> { Environment.MachineName, "localhost" };
        try
        {
            var fqdn = Dns.GetHostEntry(Environment.MachineName).HostName;
            if (!string.IsNullOrWhiteSpace(fqdn) && !names.Contains(fqdn, StringComparer.OrdinalIgnoreCase))
                names.Add(fqdn);
        }
        catch (SocketException)
        {
        }
        return names;
    }

    private static IEnumerable<IPInterfaceProperties> UpInterfaces() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .Select(n => n.GetIPProperties());

    private static bool Usable(IPAddress ip) =>
        ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip) && !ip.ToString().StartsWith("169.254.", StringComparison.Ordinal);

    /// <summary>설치 스크립트와 같은 규칙: 쓰는 중인 IPv4 모두 (127.*, 169.254.* 제외)</summary>
    private static List<IPAddress> LocalAddresses() =>
        [.. UpInterfaces().SelectMany(p => p.UnicastAddresses).Select(a => a.Address).Where(Usable).Distinct()];

    /// <summary>기본 게이트웨이가 있는 어댑터의 IPv4 (설치 스크립트의 Get-PrimaryIPv4). 네트워크가 아직 안 잡혔으면 null</summary>
    private static IPAddress? PrimaryAddress() =>
        UpInterfaces()
            .Where(p => p.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any)))
            .SelectMany(p => p.UnicastAddresses)
            .Select(a => a.Address)
            .FirstOrDefault(Usable);
}

/// <summary>네트워크 주소가 바뀌면(잠시 기다렸다가) 그리고 한 시간마다 인증서를 확인한다</summary>
public sealed class CertificateRenewer(InstalledCertificate certificate, ILogger<CertificateRenewer> logger) : BackgroundService
{
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var changed = new SemaphoreSlim(0);
        NetworkAddressChangedEventHandler onChange = (_, _) => changed.Release();
        NetworkChange.NetworkAddressChanged += onChange;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (await changed.WaitAsync(Interval, stoppingToken))
                {
                    // DHCP 갱신 등으로 몇 번 연달아 오므로 잠잠해질 때까지 기다린다
                    await Task.Delay(Settle, stoppingToken);
                    while (changed.CurrentCount > 0)
                        await changed.WaitAsync(stoppingToken);
                }
                try
                {
                    if (certificate.Ensure() is { } message)
                        logger.LogInformation("{Message}", message);
                }
                catch (Exception ex) when (ex is CryptographicException or UnauthorizedAccessException or IOException or System.Text.Json.JsonException)
                {
                    logger.LogWarning("HTTPS 인증서 갱신 실패: {Message}", ex.Message);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 종료
        }
        finally
        {
            NetworkChange.NetworkAddressChanged -= onChange;
        }
    }
}

public static class InstalledCertificateSetup
{
    /// <summary>
    /// Kestrel 'Https' 엔드포인트가 설정의 고정 인증서 대신 지금 인증서를 쓰게 하고, 갱신 감시를 등록한다.
    /// 시작할 때 한 번 확인해 바꾼 내용을 돌려준다 (앱이 만들어진 뒤 로그로 남긴다)
    /// </summary>
    public static string? UseRenewingCertificate(this WebApplicationBuilder builder, ServerOptions options,
        StoreLocation location, string exportPath, string configPath)
    {
        var certificate = new InstalledCertificate(options, location, exportPath, configPath);
        string? message;
        try
        {
            message = certificate.Ensure();
        }
        catch (Exception ex) when (ex is CryptographicException or UnauthorizedAccessException or IOException or System.Text.Json.JsonException)
        {
            message = "HTTPS 인증서 확인 실패: " + ex.Message;
        }
        builder.WebHost.ConfigureKestrel((context, kestrel) =>
            kestrel.Configure(context.Configuration.GetSection("Kestrel"))
                .Endpoint("Https", endpoint =>
                {
                    var configured = endpoint.HttpsOptions.ServerCertificate;
                    endpoint.HttpsOptions.ServerCertificateSelector = (_, _) => certificate.Current ?? configured;
                }));
        builder.Services.AddSingleton(certificate);
        builder.Services.AddHostedService<CertificateRenewer>();
        return message;
    }
}
