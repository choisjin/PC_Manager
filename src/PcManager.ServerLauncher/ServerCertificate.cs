using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace PcManager.ServerLauncher;

/// <summary>
/// 이 PC의 서버들이 같이 쓰는 HTTPS 자체 서명 인증서 (https\PcManager-Server.pfx + 공개 .cer).
/// 원격조작 키보드 잠금·WebCodecs는 HTTPS에서만 되기 때문. 관리자 권한 없이 파일로 만든다.
/// - 에이전트: 서버에 등록할 때 .cer를 받아 자동으로 신뢰 (서버가 /api/install/PcManager-Server.cer로 내려줌)
/// - 이 PC: 런처가 관리자 승인 한 번으로 신뢰 저장소(LocalMachine\Root)에 넣음
/// - 다른 대시보드 PC: 대시보드 'PC 추가' 창의 인증서 설치 도구
/// 주체 이름에 PC 이름을 넣어 설치형 서버 인증서(CN=PC Manager Server)나 다른 PC 인증서와 구별한다
/// (신뢰 저장소에 넣을 때 같은 주체의 이전 인증서를 지우므로)
/// </summary>
internal static class ServerCertificate
{
    public static string Directory => Path.Combine(LauncherPaths.Root, "https");
    public static string PfxPath => Path.Combine(Directory, "PcManager-Server.pfx");
    public static string CerPath => Path.Combine(Directory, "PcManager-Server.cer");
    private static string Subject => $"CN=PC Manager Server ({Environment.MachineName})";

    /// <summary>없거나, 곧 만료되거나, 이 PC의 IP가 바뀌었으면 새로 만든다. 새로 만들었으면 true</summary>
    public static bool Ensure()
    {
        var names = HostNames();
        var ips = AddressList();
        if (Load() is { } existing)
        {
            using (existing)
            {
                if (existing.NotAfter > DateTime.Now.AddDays(30) && Covers(existing, names, ips))
                    return false;
            }
        }

        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(Subject, rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        foreach (var name in names)
            san.AddDnsName(name);
        foreach (var ip in ips)
            san.AddIpAddress(ip);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, critical: true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], critical: false));
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, critical: true));

        using var certificate = request.CreateSelfSigned(DateTimeOffset.Now.AddDays(-1), DateTimeOffset.Now.AddYears(10));
        System.IO.Directory.CreateDirectory(Directory);
        File.WriteAllBytes(PfxPath, certificate.Export(X509ContentType.Pfx));
        File.WriteAllBytes(CerPath, certificate.Export(X509ContentType.Cert));
        return true;
    }

    public static bool Exists => File.Exists(PfxPath) && File.Exists(CerPath);

    /// <summary>이 PC의 신뢰 저장소에 들어 있는지 (읽기는 관리자 권한 없이 가능)</summary>
    public static bool IsTrustedHere()
    {
        if (!File.Exists(CerPath))
            return false;
        using var certificate = X509CertificateLoader.LoadCertificateFromFile(CerPath);
        using var root = new X509Store(StoreName.Root, StoreLocation.LocalMachine);
        root.Open(OpenFlags.ReadOnly);
        return root.Certificates.Find(X509FindType.FindByThumbprint, certificate.Thumbprint, validOnly: false).Count > 0;
    }

    /// <summary>이 PC 신뢰 저장소에 넣는다 (certutil 승격 실행, UAC 한 번). 같은 주체의 이전 인증서는 지운다</summary>
    public static bool TryTrustHere(out string? error)
    {
        error = null;
        try
        {
            using var process = Process.Start(new ProcessStartInfo("cmd.exe",
                $"/c certutil -delstore Root \"{Subject[3..]}\" >nul & certutil -f -addstore Root \"{CerPath}\"")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            process?.WaitForExit(30_000);
            if (!IsTrustedHere())
            {
                error = "신뢰 저장소에 넣지 못했습니다.";
                return false;
            }
            return true;
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            error = "관리자 승인이 취소됐습니다.";
            return false;
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    private static X509Certificate2? Load()
    {
        try
        {
            return Exists ? X509CertificateLoader.LoadPkcs12FromFile(PfxPath, password: null) : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
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

    /// <summary>사용 중인 모든 IPv4 + 127.0.0.1 (어느 주소로 열어도 맞도록)</summary>
    private static List<IPAddress> AddressList()
    {
        var list = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Select(a => a.Address)
            .Where(a => a.AddressFamily == AddressFamily.InterNetwork)
            .ToList();
        list.Add(IPAddress.Loopback);
        return list.Distinct().ToList();
    }
}
