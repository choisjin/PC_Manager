using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PcManager.Server.Services;

/// <summary>
/// 로그인 세션 · 자동 로그인 · 프로젝트 관리자 비밀번호 (auth.json).
/// - 세션: 메모리에만 (서버를 다시 켜면 자동 로그인 토큰으로 다시 받는다)
/// - 자동 로그인 토큰: 30일, 쓸 때마다 연장. 파일에는 SHA-256 해시만
/// - 관리자 비밀번호: 솔트+PBKDF2 해시. 아직 바꾸지 않은 프로젝트는 기본값 admin
/// </summary>
public class AuthStore(AppPaths paths)
{
    public const string DefaultAdminPassword = "admin";
    public static readonly TimeSpan RememberLifetime = TimeSpan.FromDays(30);

    private const int Iterations = 100_000;
    private const int MaxFailures = 5;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(5);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "auth.json");
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    // 프로젝트별 최근 관리자 비밀번호 실패 시각 (무차별 대입 막기)
    private readonly Dictionary<string, List<DateTime>> _failures = [];
    private Data? _data;

    public record Session(string UserId, string ProjectId);

    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class Data
    {
        /// <summary>projectId → 관리자 비밀번호 {Salt, Hash}</summary>
        public Dictionary<string, PasswordRecord> Admins { get; set; } = [];
        public List<RememberRecord> Remember { get; set; } = [];
    }

    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class PasswordRecord
    {
        public required string Salt { get; set; }
        public required string Hash { get; set; }
    }

    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class RememberRecord
    {
        public required string H { get; set; }
        public required string UserId { get; set; }
        public required string ProjectId { get; set; }
        public DateTimeOffset Exp { get; set; }
    }

    // ── 세션 ──

    public string IssueSession(string userId, string projectId)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        _sessions[token] = new Session(userId, projectId);
        return token;
    }

    public Session? GetSession(HttpContext context)
    {
        var auth = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (!auth.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return null;
        return _sessions.GetValueOrDefault(auth[prefix.Length..].Trim());
    }

    public void DropSession(HttpContext context)
    {
        var auth = context.Request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            _sessions.TryRemove(auth[7..].Trim(), out _);
    }

    // ── 자동 로그인 ──

    public string IssueRemember(string userId, string projectId)
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        lock (_lock)
        {
            var data = Load();
            Prune(data);
            data.Remember.Add(new RememberRecord { H = HashToken(token), UserId = userId, ProjectId = projectId, Exp = DateTimeOffset.UtcNow.Add(RememberLifetime) });
            Save();
        }
        return token;
    }

    /// <summary>자동 로그인 토큰 → (사용자, 프로젝트). 쓸 때마다 만료일을 30일 뒤로</summary>
    public Session? UseRemember(string? token)
    {
        if (string.IsNullOrEmpty(token))
            return null;
        var h = HashToken(token);
        lock (_lock)
        {
            var data = Load();
            Prune(data);
            var row = data.Remember.FirstOrDefault(r => r.H == h);
            if (row is null)
                return null;
            row.Exp = DateTimeOffset.UtcNow.Add(RememberLifetime);
            Save();
            return new Session(row.UserId, row.ProjectId);
        }
    }

    public void RevokeRemember(string? token)
    {
        if (string.IsNullOrEmpty(token))
            return;
        var h = HashToken(token);
        Revoke(r => r.H == h);
    }

    // ── 관리자 비밀번호 ──

    public bool VerifyAdmin(string projectId, string? password)
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            if (!_failures.TryGetValue(projectId, out var failures))
                _failures[projectId] = failures = [];
            failures.RemoveAll(t => now - t > FailureWindow);
            if (failures.Count >= MaxFailures)
            {
                var wait = FailureWindow - (now - failures[0]);
                throw new InvalidOperationException($"관리자 비밀번호를 {MaxFailures}번 틀렸습니다. {Math.Max(1, (int)Math.Ceiling(wait.TotalMinutes))}분 뒤 다시 시도하세요.");
            }
            var ok = Load().Admins.TryGetValue(projectId, out var record)
                ? CryptographicOperations.FixedTimeEquals(
                    Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password ?? ""), Convert.FromBase64String(record.Salt), Iterations, HashAlgorithmName.SHA256, 32),
                    Convert.FromBase64String(record.Hash))
                : password == DefaultAdminPassword;
            if (ok)
                failures.Clear();
            else
                failures.Add(now);
            return ok;
        }
    }

    /// <summary>관리자 비밀번호 변경. 다른 브라우저에 남은 관리자 자동 로그인은 해제</summary>
    public void SetAdminPassword(string projectId, string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, Iterations, HashAlgorithmName.SHA256, 32);
        lock (_lock)
        {
            Load().Admins[projectId] = new PasswordRecord { Salt = Convert.ToBase64String(salt), Hash = Convert.ToBase64String(hash) };
            Save();
        }
        Revoke(r => r.UserId == OrgStore.AdminId(projectId));
    }

    /// <summary>프로젝트 삭제: 관리자 비밀번호 · 세션 · 자동 로그인 모두 정리</summary>
    public void RemoveProject(string projectId)
    {
        lock (_lock)
        {
            Load().Admins.Remove(projectId);
            Save();
        }
        foreach (var (token, _) in _sessions.Where(kv => kv.Value.ProjectId == projectId).ToList())
            _sessions.TryRemove(token, out _);
        Revoke(r => r.ProjectId == projectId);
    }

    // ── 내부 ──

    private void Revoke(Func<RememberRecord, bool> match)
    {
        lock (_lock)
        {
            var data = Load();
            if (data.Remember.RemoveAll(r => match(r)) > 0)
                Save();
        }
    }

    private static void Prune(Data data) => data.Remember.RemoveAll(r => r.Exp <= DateTimeOffset.UtcNow);

    private static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private Data Load()
    {
        if (_data is not null)
            return _data;
        try
        {
            _data = File.Exists(_path) ? JsonSerializer.Deserialize<Data>(File.ReadAllText(_path), Json) ?? new Data() : new Data();
        }
        catch (JsonException)
        {
            // 깨진 파일을 덮어쓰면 바꾼 관리자 비밀번호가 기본값으로 돌아가므로 옆에 남긴다
            File.Copy(_path, _path + ".broken", overwrite: true);
            _data = new Data();
        }
        return _data;
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(Load(), Json));
        File.Move(temp, _path, overwrite: true);
    }
}
