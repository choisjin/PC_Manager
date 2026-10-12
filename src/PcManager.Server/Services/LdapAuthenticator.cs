using System.DirectoryServices.Protocols;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace PcManager.Server.Services;

/// <summary>
/// LG전자 사내 LDAP(Active Directory) 인증 — APMS services/Operation_Report/ldap_auth.py 를 옮김.
/// {id}@lge.net 으로 LDAPS 바인드 후 cn 으로 이름·메일·부서를 찾는다.
/// 접근 제어는 설정(환경 변수 이름 그대로, 비우면 LDAP 인증만 되면 허용):
///   LDAP_ACCESS_CONTROL_ENABLED  true/false (기본 true)
///   LDAP_ALLOWED_TEAMS           허용 팀 (쉼표 구분)
///   LDAP_ALLOWED_USERS           허용 사용자 ID (쉼표 구분)
///   LDAP_BLOCKED_USERS           차단 사용자 ID (쉼표 구분)
/// </summary>
public partial class LdapAuthenticator(IConfiguration config, ILogger<LdapAuthenticator> logger)
{
    private static readonly string[] Servers = ["lgesaads01.lge.net", "lgesaads02.lge.net", "lgesaads03.lge.net"];
    private const int Port = 636;
    private const string BaseDn = "ou=LGE Users,dc=lge,dc=net";
    private const int InvalidCredentials = 49;

    public record Result(bool Success, string Reason, OrgStore.LdapProfile? Profile = null);

    /// <summary>사용자 ID: 영문·숫자·. _ - 만 (LDAP 검색 필터에 들어가므로)</summary>
    public static bool ValidId(string? username) => IdRegex().IsMatch(username ?? "");

    /// <summary>LDAP 인증 + 차단/사용자/팀 접근 제어</summary>
    public Result Authenticate(string username, string password)
    {
        // 빈 비밀번호는 익명 바인드로 성공해 버리므로 여기서 막는다
        if (string.IsNullOrEmpty(password))
            return new Result(false, "계정 ID와 비밀번호를 입력하세요.");
        var auth = Bind(username, password);
        if (!auth.Success || auth.Profile is null)
            return auth;
        var profile = auth.Profile;

        if (!string.Equals(config["LDAP_ACCESS_CONTROL_ENABLED"] ?? "true", "true", StringComparison.OrdinalIgnoreCase))
            return auth;
        var uid = username.ToLowerInvariant();
        if (List("LDAP_BLOCKED_USERS").Any(u => u.Equals(uid, StringComparison.OrdinalIgnoreCase)))
            return new Result(false, "차단된 사용자입니다.");
        var allowedUsers = List("LDAP_ALLOWED_USERS");
        if (allowedUsers.Count > 0 && !allowedUsers.Any(u => u.Equals(uid, StringComparison.OrdinalIgnoreCase)))
            return new Result(false, "허용되지 않은 사용자입니다.");
        var allowedTeams = List("LDAP_ALLOWED_TEAMS");
        if (allowedTeams.Count > 0 && (profile.Team is null || !allowedTeams.Contains(profile.Team)))
            return new Result(false, $"현재 팀({profile.Team ?? "팀 정보 없음"})은 접근 권한이 없습니다. (허용: {string.Join(", ", allowedTeams)})");
        return auth;
    }

    /// <summary>LDAP 서버에 차례로 접속해 인증</summary>
    private Result Bind(string username, string password)
    {
        foreach (var host in Servers)
        {
            using var connection = new LdapConnection(
                new LdapDirectoryIdentifier(host, Port),
                new NetworkCredential($"{username}@lge.net", password),
                AuthType.Basic);
            connection.SessionOptions.ProtocolVersion = 3;
            connection.SessionOptions.SecureSocketLayer = true;
            connection.Timeout = TimeSpan.FromSeconds(5);
            try
            {
                connection.Bind();
            }
            catch (LdapException ex) when (ex.ErrorCode == InvalidCredentials)
            {
                // 서버에는 닿았고 자격 증명이 틀림 → 다른 서버도 결과가 같으므로 바로 끝
                return new Result(false, "아이디 또는 비밀번호가 올바르지 않습니다.");
            }
            catch (Exception ex)
            {
                logger.LogWarning("LDAP {Host} 연결 실패: {Message}", host, ex.Message);
                continue;
            }
            try
            {
                var request = new SearchRequest(BaseDn, $"(cn={EscapeFilter(username)})", SearchScope.Subtree, "cn", "mail", "displayName", "department");
                var response = (SearchResponse)connection.SendRequest(request);
                if (response.Entries.Count == 0)
                    return new Result(false, "사용자 정보를 찾을 수 없습니다.");
                var entry = response.Entries[0];
                var cn = Attr(entry, "cn") ?? username;
                var displayName = Attr(entry, "displayName") ?? username;
                // displayName "이름/직급/팀이름"
                var parts = displayName.Split('/');
                var team = parts.Length >= 3 ? parts[2].Trim() : null;
                var title = parts.Length >= 3 ? parts[1].Trim() : null;
                var name = parts[0].Trim();
                return new Result(true, "접근 허용", new OrgStore.LdapProfile(
                    cn,
                    string.IsNullOrEmpty(name) ? username : name,
                    title,
                    team,
                    Attr(entry, "department"),
                    Attr(entry, "mail")));
            }
            catch (Exception ex)
            {
                logger.LogWarning("LDAP {Host} 사용자 검색 실패: {Message}", host, ex.Message);
            }
        }
        return new Result(false, "LDAP 서버에 연결하지 못했습니다. 사내망 연결을 확인하세요.");
    }

    private static string? Attr(SearchResultEntry entry, string name)
    {
        var values = entry.Attributes[name];
        if (values is null || values.Count == 0)
            return null;
        var value = values[0] switch
        {
            string s => s,
            byte[] b => Encoding.UTF8.GetString(b),
            var o => o?.ToString(),
        };
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string EscapeFilter(string value)
    {
        var sb = new StringBuilder();
        foreach (var c in value)
            sb.Append(c switch
            {
                '\\' => @"\5c",
                '*' => @"\2a",
                '(' => @"\28",
                ')' => @"\29",
                '\0' => @"\00",
                _ => c.ToString(),
            });
        return sb.ToString();
    }

    private List<string> List(string key) =>
        (config[key] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    [GeneratedRegex(@"^[A-Za-z0-9._-]{1,64}$")]
    private static partial Regex IdRegex();
}
