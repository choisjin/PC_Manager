using System.Security.Cryptography.X509Certificates;

namespace PcManager.Shared;

/// <summary>
/// 서버의 자체 서명 HTTPS 인증서를 이 PC의 "신뢰할 수 있는 루트 인증 기관"(LocalMachine\Root)에 넣는다.
/// 서버(시작 시 자기 인증서)와 에이전트(등록 시 서버에서 받은 인증서)가 같이 쓴다. 관리자/SYSTEM 권한이 필요하다.
/// </summary>
public static class CertificateTrust
{
    /// <summary>서버 인증서 주체 이름 (설치 스크립트의 New-SelfSignedCertificate -Subject와 같아야 한다)</summary>
    public const string ServerSubject = "CN=PC Manager Server";

    /// <returns>새로 넣었으면 true, 이미 있으면 false</returns>
    public static bool EnsureTrustedRoot(X509Certificate2 certificate)
    {
        if (!OperatingSystem.IsWindows())
            return false;

        using var root = new X509Store(StoreName.Root, StoreLocation.LocalMachine);
        root.Open(OpenFlags.ReadWrite);

        var already = root.Certificates.Find(X509FindType.FindByThumbprint, certificate.Thumbprint, validOnly: false).Count > 0;
        if (already)
            return false;

        // 같은 주체의 이전 인증서(재발급 전)는 지워서 쌓이지 않게 한다
        foreach (var old in root.Certificates.Find(X509FindType.FindBySubjectDistinguishedName, certificate.Subject, validOnly: false))
            root.Remove(old);

        // 개인 키 없이 공개 인증서만 넣는다
        using var publicOnly = X509CertificateLoader.LoadCertificate(certificate.Export(X509ContentType.Cert));
        root.Add(publicOnly);
        return true;
    }

    /// <summary>LocalMachine\My에서 주체 이름으로 인증서를 찾는다 (Kestrel과 같은 규칙: 부분 문자열, 만료가 가장 늦은 것)</summary>
    public static X509Certificate2? FindServerCertificate(string subjectName)
    {
        if (!OperatingSystem.IsWindows())
            return null;

        using var my = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        my.Open(OpenFlags.ReadOnly);
        return my.Certificates.Find(X509FindType.FindBySubjectName, subjectName, validOnly: false)
            .OrderByDescending(c => c.NotAfter)
            .FirstOrDefault();
    }
}
