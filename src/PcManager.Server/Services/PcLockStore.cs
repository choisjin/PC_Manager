using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PcManager.Server.Services;

/// <summary>
/// PC PIN 잠금 (pc-locks.json). 잠긴 PC는 PIN을 넣은 브라우저만 파일 탐색·원격조작을 할 수 있고, 썸네일은 아무에게도 보이지 않는다.
/// PIN은 솔트+PBKDF2 해시로만 저장한다. PIN이 맞으면 PC별 서명 쿠키를 준다 (브라우저가 모든 요청·WebSocket·다운로드에 실어 보냄).
/// PIN을 바꾸거나 잠금을 다시 걸면 솔트가 바뀌어 이전 쿠키는 쓸 수 없다.
/// </summary>
public partial class PcLockStore(AppPaths paths)
{
    public const string CookiePrefix = "pcm_unlock_";
    public static readonly TimeSpan UnlockLifetime = TimeSpan.FromHours(12);

    private const int Iterations = 100_000;
    private const int MaxFailures = 5;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(5);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "pc-locks.json");
    private readonly string _keyPath = Path.Combine(paths.DataDirectory, "pc-lock.key");
    private Dictionary<string, LockRecord>? _locks;
    private byte[]? _key;
    // PC별 최근 PIN 실패 시각 (무차별 대입 막기)
    private readonly Dictionary<string, List<DateTime>> _failures = [];

    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class LockRecord
    {
        public required string AgentId { get; init; }
        public required string Salt { get; set; }
        public required string Hash { get; set; }
        public string? OwnerUserId { get; init; }
        public DateTime LockedAt { get; init; }
    }

    public record LockInfo(string AgentId, string? OwnerUserId, DateTime LockedAt);

    public bool IsLocked(string agentId)
    {
        lock (_lock)
        {
            return Locks().ContainsKey(agentId);
        }
    }

    public IReadOnlyList<LockInfo> All()
    {
        lock (_lock)
        {
            return Locks().Values.Select(l => new LockInfo(l.AgentId, l.OwnerUserId, l.LockedAt)).ToList();
        }
    }

    public void SetLock(string agentId, string pin, string? ownerUserId)
    {
        ValidatePin(pin);
        lock (_lock)
        {
            if (Locks().ContainsKey(agentId))
                throw new InvalidOperationException("이미 잠긴 PC입니다. PIN을 바꾸려면 'PIN 변경'을 쓰세요.");
            var (salt, hash) = HashPin(pin);
            Locks()[agentId] = new LockRecord { AgentId = agentId, Salt = salt, Hash = hash, OwnerUserId = ownerUserId, LockedAt = DateTime.UtcNow };
            Save();
        }
    }

    public void ChangePin(string agentId, string pin, string newPin)
    {
        ValidatePin(newPin);
        lock (_lock)
        {
            var record = Verify(agentId, pin);
            (record.Salt, record.Hash) = HashPin(newPin);
            Save();
        }
    }

    public void RemoveLock(string agentId, string pin)
    {
        lock (_lock)
        {
            Verify(agentId, pin);
            Locks().Remove(agentId);
            Save();
        }
    }

    /// <summary>PIN 확인 → 잠금 해제 쿠키 값</summary>
    public string Unlock(string agentId, string pin)
    {
        lock (_lock)
        {
            var record = Verify(agentId, pin);
            var expires = DateTimeOffset.UtcNow.Add(UnlockLifetime).ToUnixTimeSeconds();
            return $"{expires}.{Sign(record, expires)}";
        }
    }

    /// <summary>잠기지 않았거나, 이 요청에 맞는 잠금 해제 쿠키가 있으면 true</summary>
    public bool CanAccess(HttpContext context, string agentId)
    {
        lock (_lock)
        {
            if (!Locks().TryGetValue(agentId, out var record))
                return true;
            var value = context.Request.Cookies[CookiePrefix + agentId];
            if (string.IsNullOrEmpty(value))
                return false;
            var dot = value.IndexOf('.');
            if (dot <= 0 || !long.TryParse(value[..dot], out var expires) || expires < DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                return false;
            return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(value[(dot + 1)..]), Encoding.ASCII.GetBytes(Sign(record, expires)));
        }
    }

    // ── 내부 ──

    private LockRecord Verify(string agentId, string pin)
    {
        if (!Locks().TryGetValue(agentId, out var record))
            throw new KeyNotFoundException("잠기지 않은 PC입니다.");
        var now = DateTime.UtcNow;
        if (!_failures.TryGetValue(agentId, out var failures))
            _failures[agentId] = failures = [];
        failures.RemoveAll(t => now - t > FailureWindow);
        if (failures.Count >= MaxFailures)
        {
            var wait = FailureWindow - (now - failures[0]);
            throw new InvalidOperationException($"PIN을 {MaxFailures}번 틀렸습니다. {Math.Max(1, (int)Math.Ceiling(wait.TotalMinutes))}분 뒤 다시 시도하세요.");
        }
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(pin ?? ""), Convert.FromBase64String(record.Salt), Iterations, HashAlgorithmName.SHA256, 32);
        if (!CryptographicOperations.FixedTimeEquals(hash, Convert.FromBase64String(record.Hash)))
        {
            failures.Add(now);
            throw new UnauthorizedAccessException($"PIN이 맞지 않습니다. ({failures.Count}/{MaxFailures})");
        }
        failures.Clear();
        return record;
    }

    private static void ValidatePin(string pin)
    {
        if (!PinRegex().IsMatch(pin ?? ""))
            throw new ArgumentException("PIN은 숫자 4~12자리입니다.");
    }

    private static (string Salt, string Hash) HashPin(string pin)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(pin), salt, Iterations, HashAlgorithmName.SHA256, 32);
        return (Convert.ToBase64String(salt), Convert.ToBase64String(hash));
    }

    // 솔트를 넣어 서명: PIN을 바꾸면 이전 쿠키가 무효
    private string Sign(LockRecord record, long expires)
    {
        var data = Encoding.UTF8.GetBytes($"{record.AgentId}|{expires}|{record.Salt}");
        return Convert.ToBase64String(HMACSHA256.HashData(Key(), data)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private byte[] Key()
    {
        if (_key is not null)
            return _key;
        if (File.Exists(_keyPath) && File.ReadAllBytes(_keyPath) is { Length: 32 } existing)
            return _key = existing;
        _key = RandomNumberGenerator.GetBytes(32);
        Directory.CreateDirectory(Path.GetDirectoryName(_keyPath)!);
        File.WriteAllBytes(_keyPath, _key);
        return _key;
    }

    private Dictionary<string, LockRecord> Locks()
    {
        if (_locks is not null)
            return _locks;
        _locks = [];
        try
        {
            if (File.Exists(_path))
                foreach (var record in JsonSerializer.Deserialize<List<LockRecord>>(File.ReadAllText(_path), Json) ?? [])
                    _locks[record.AgentId] = record;
        }
        catch (JsonException)
        {
            // 깨진 파일을 덮어쓰면 잠금이 풀리므로 옆에 남긴다
            File.Copy(_path, _path + ".broken", overwrite: true);
        }
        return _locks;
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(Locks().Values.ToList(), Json));
        File.Move(temp, _path, overwrite: true);
    }

    [GeneratedRegex(@"^\d{4,12}$")]
    private static partial Regex PinRegex();
}
