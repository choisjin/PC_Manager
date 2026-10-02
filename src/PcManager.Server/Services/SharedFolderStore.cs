using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 서버가 직접 접근하는 공유 폴더 목록. 사용자마다 따로 등록·저장한다 (등록한 사용자에게만 보임).
/// 네트워크 자격증명은 DPAPI로 암호화 저장하고, 파일에 접근할 때마다 그 자격증명으로 로그온해서(가장) 접근한다.
/// 그래서 같은 공유 서버를 사용자마다 다른 계정으로 써도 서로 충돌하지 않는다.
/// </summary>
public class SharedFolderStore(AppPaths paths, ILogger<SharedFolderStore> logger)
{
    private const int MaxSharesPerUser = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "shared-folders.json");

    // 공유 폴더 id → 자격증명으로 로그온한 토큰 (네트워크 접근에만 쓰임)
    private readonly ConcurrentDictionary<string, SafeAccessTokenHandle> _tokens = new();

    /// <summary>저장용 내부 모델 (비밀번호는 암호화된 상태)</summary>
    private record Stored(string Id, string Name, string Path, string? Username, string? ProtectedPassword, string? OwnerUserId = null);

    private List<Stored> LoadUnlocked()
    {
        if (!File.Exists(_path))
            return [];
        try
        {
            return JsonSerializer.Deserialize<List<Stored>>(File.ReadAllText(_path), Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static SharedFolder ToView(Stored s) => new(s.Id, s.Name, s.Path, s.Username, s.OwnerUserId);

    // 내 것 + 예전에 주인 없이 등록된 공용 공유
    private static bool VisibleTo(Stored s, string? userId) =>
        s.OwnerUserId is null || (userId is not null && s.OwnerUserId == userId);

    /// <summary>이 사용자에게 보이는 공유 폴더</summary>
    public SharedFoldersView Load(string? userId)
    {
        lock (_lock)
        {
            return new SharedFoldersView(LoadUnlocked().Where(s => VisibleTo(s, userId)).Select(ToView).ToList());
        }
    }

    public bool TryGet(string id, out SharedFolder share)
    {
        lock (_lock)
        {
            var found = LoadUnlocked().FirstOrDefault(s => s.Id == id);
            share = found is null ? null! : ToView(found);
            return found is not null;
        }
    }

    public static bool IsNetworkPath(string path) => path.StartsWith(@"\\", StringComparison.Ordinal);

    /// <summary>
    /// 자격증명 없이(서버 계정으로) 열리는지 확인한다. 등록 화면이 사용자 이름·비밀번호를 필수로 요구할지 정하는 데 쓴다.
    /// </summary>
    public static ShareProbeResult Probe(string path)
    {
        var cleanPath = path.Trim().TrimEnd('\\', '/');
        if (cleanPath.Length == 0)
            return new ShareProbeResult(false, false, "경로를 입력하세요.");
        // 서버 주소만(\\서버): 탐색기처럼 그 서버의 공유 목록을 연다
        if (NetworkShares.IsServerRoot(cleanPath))
        {
            var code = NetworkShares.TryList(cleanPath, out _);
            return code == 0 ? new ShareProbeResult(true, false, null)
                : NetworkShares.IsAccessError(code) ? new ShareProbeResult(false, true, null)
                : new ShareProbeResult(false, false, $"공유 서버에 연결할 수 없습니다 (코드 {code}). 주소와 네트워크 연결을 확인하세요.");
        }
        try
        {
            // 목록을 실제로 읽어 봐야 권한 문제를 알 수 있다 (Directory.Exists는 권한이 없어도 false만 준다)
            using var entries = Directory.EnumerateFileSystemEntries(cleanPath).GetEnumerator();
            entries.MoveNext();
            return new ShareProbeResult(true, false, null);
        }
        catch (UnauthorizedAccessException)
        {
            return new ShareProbeResult(false, true, null);
        }
        catch (IOException ex)
        {
            // 로그온 실패·권한 없음·자격증명 충돌 → 자격증명 필요. 경로·서버를 못 찾음 → 오류
            var code = ex.HResult & 0xFFFF;
            if (code is 5 or 86 or 1219 or 1326 or 1327 or 1330 or 1331 or 1385 or 1907 or 1909 or 2242)
                return new ShareProbeResult(false, true, null);
            return code is 2 or 3 or 53 or 67 or 1231 or 1232 or 64
                ? new ShareProbeResult(false, false, IsNetworkPath(cleanPath)
                    ? "공유 서버나 공유 폴더를 찾을 수 없습니다. 경로와 네트워크 연결을 확인하세요."
                    : "폴더가 없습니다.")
                : new ShareProbeResult(false, true, ex.Message);
        }
        catch (ArgumentException ex)
        {
            return new ShareProbeResult(false, false, ex.Message);
        }
    }

    /// <summary>공유 폴더 추가. 자격증명 없이 열리지 않는 공유는 자격증명이 필수이며, 그 자격증명으로 접근되는지 확인한 뒤 저장한다.</summary>
    public SharedFolder Add(string? userId, string name, string path, string? username, string? password)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("공유 폴더는 사용자별로 저장됩니다. 먼저 사용자를 선택(로그인)하세요.");
        var cleanPath = path.Trim().TrimEnd('\\', '/');
        if (string.IsNullOrWhiteSpace(cleanPath))
            throw new ArgumentException("경로를 입력하세요.");

        var hasCredentials = !string.IsNullOrWhiteSpace(username);
        if (!hasCredentials)
        {
            // 자격증명 없이 열리는 폴더만 그대로 등록
            var probe = Probe(cleanPath);
            if (probe.NeedsCredentials)
                throw new ArgumentException("이 폴더는 권한이 필요합니다. 사용자 이름과 비밀번호를 입력하세요.");
            if (!probe.Accessible)
                throw new DirectoryNotFoundException(probe.Error ?? $"폴더에 접근할 수 없습니다: {cleanPath}");
        }

        // 그 자격증명으로 실제로 열리는지 확인
        if (hasCredentials)
        {
            using var token = LogonNetwork(username!.Trim(), password ?? "", cleanPath);
            var exists = WindowsIdentity.RunImpersonated(token, () =>
                NetworkShares.IsServerRoot(cleanPath) ? NetworkShares.TryList(cleanPath, out _) == 0 : Directory.Exists(cleanPath));
            if (!exists)
                throw new DirectoryNotFoundException($"그 자격증명으로 폴더에 접근할 수 없습니다: {cleanPath} (경로·사용자 이름·비밀번호 확인)");
        }
        else if (NetworkShares.IsServerRoot(cleanPath) ? NetworkShares.TryList(cleanPath, out _) != 0 : !Directory.Exists(cleanPath))
        {
            throw new DirectoryNotFoundException($"폴더에 접근할 수 없습니다: {cleanPath}");
        }

        var cleanName = string.IsNullOrWhiteSpace(name)
            ? (NetworkShares.IsServerRoot(cleanPath) ? cleanPath.TrimStart('\\') : Path.GetFileName(cleanPath) is { Length: > 0 } leaf ? leaf : cleanPath)
            : name.Trim();

        lock (_lock)
        {
            var list = LoadUnlocked();
            if (list.Count(s => s.OwnerUserId == userId) >= MaxSharesPerUser)
                throw new InvalidOperationException("공유 폴더가 너무 많습니다.");
            // 같은 사용자가 같은 경로를 다시 등록하면 자격증명·이름을 갱신한다
            var existing = list.FirstOrDefault(s => s.OwnerUserId == userId && string.Equals(s.Path, cleanPath, StringComparison.OrdinalIgnoreCase));
            var stored = new Stored(
                existing?.Id ?? Guid.NewGuid().ToString("N"),
                cleanName,
                cleanPath,
                hasCredentials ? username!.Trim() : null,
                hasCredentials ? Protect(password ?? "") : null,
                userId);
            if (existing is not null)
                list[list.IndexOf(existing)] = stored;
            else
                list.Add(stored);
            Save(list);
            DropToken(stored.Id);
            return ToView(stored);
        }
    }

    /// <summary>표시 이름(별칭) 변경. 자기 것이나 공용만 바꿀 수 있다.</summary>
    public SharedFolder Rename(string? userId, string id, string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("이름을 입력하세요.");
        lock (_lock)
        {
            var list = LoadUnlocked();
            var found = list.FirstOrDefault(s => s.Id == id && VisibleTo(s, userId))
                ?? throw new KeyNotFoundException("공유 폴더를 찾을 수 없습니다.");
            var renamed = found with { Name = name.Trim() };
            list[list.IndexOf(found)] = renamed;
            Save(list);
            return ToView(renamed);
        }
    }

    /// <summary>이 사용자에게 보이는 공유 폴더의 표시 순서를 바꾼다 (ids 순서대로, 빠진 것은 뒤에)</summary>
    public SharedFoldersView Reorder(string? userId, IReadOnlyList<string> ids)
    {
        lock (_lock)
        {
            var list = LoadUnlocked();
            var visible = list.Where(s => VisibleTo(s, userId)).ToList();
            var ordered = ids.Select(id => visible.FirstOrDefault(s => s.Id == id)).OfType<Stored>()
                .Concat(visible.Where(s => !ids.Contains(s.Id)))
                .ToList();
            // 보이는 항목들이 있던 자리에 새 순서로 다시 채운다 (다른 사용자 항목 위치는 그대로)
            var queue = new Queue<Stored>(ordered);
            for (var i = 0; i < list.Count; i++)
            {
                if (VisibleTo(list[i], userId))
                    list[i] = queue.Dequeue();
            }
            Save(list);
            return new SharedFoldersView(list.Where(s => VisibleTo(s, userId)).Select(ToView).ToList());
        }
    }

    public void Remove(string? userId, string id)
    {
        lock (_lock)
        {
            var list = LoadUnlocked();
            list.RemoveAll(s => s.Id == id && VisibleTo(s, userId));
            Save(list);
        }
        DropToken(id);
    }

    /// <summary>공유 폴더의 자격증명으로 작업한다 (자격증명이 없으면 서버 계정 그대로).</summary>
    public T RunAs<T>(SharedFolder share, Func<T> work)
    {
        var token = TokenFor(share.Id);
        return token is null ? work() : WindowsIdentity.RunImpersonated(token, work);
    }

    public void RunAs(SharedFolder share, Action work) => RunAs(share, () => { work(); return 0; });

    public Task<T> RunAsAsync<T>(SharedFolder share, Func<Task<T>> work)
    {
        var token = TokenFor(share.Id);
        return token is null ? work() : WindowsIdentity.RunImpersonatedAsync(token, work);
    }

    public Task RunAsAsync(SharedFolder share, Func<Task> work)
    {
        var token = TokenFor(share.Id);
        return token is null ? work() : WindowsIdentity.RunImpersonatedAsync(token, work);
    }

    private SafeAccessTokenHandle? TokenFor(string id)
    {
        if (_tokens.TryGetValue(id, out var cached) && !cached.IsInvalid && !cached.IsClosed)
            return cached;
        Stored? stored;
        lock (_lock)
        {
            stored = LoadUnlocked().FirstOrDefault(s => s.Id == id);
        }
        if (stored is null || string.IsNullOrWhiteSpace(stored.Username))
            return null;
        try
        {
            var token = LogonNetwork(stored.Username, Unprotect(stored.ProtectedPassword), stored.Path);
            _tokens[id] = token;
            return token;
        }
        catch (Exception ex) when (ex is IOException or CryptographicException or FormatException)
        {
            logger.LogWarning("공유 폴더 로그온 실패 {Path}: {Message}", stored.Path, ex.Message);
            throw new IOException($"공유 폴더 자격증명으로 로그온하지 못했습니다: {ex.Message}", ex);
        }
    }

    private void DropToken(string id)
    {
        if (_tokens.TryRemove(id, out var token))
            token.Dispose();
    }

    /// <summary>
    /// 네트워크 접근 전용 로그온 (LOGON32_LOGON_NEW_CREDENTIALS). 로컬에서는 서버 계정 그대로이고
    /// 공유 서버에 접속할 때만 이 자격증명을 쓴다. 비밀번호가 틀려도 여기서는 성공하고, 실제 접근 시 실패한다.
    /// </summary>
    private static SafeAccessTokenHandle LogonNetwork(string username, string password, string path)
    {
        string user = username;
        string? domain;
        if (username.Contains('\\'))
        {
            var parts = username.Split('\\', 2);
            domain = parts[0];
            user = parts[1];
        }
        else if (username.Contains('@'))
        {
            domain = null;
        }
        else
        {
            // 도메인 없이 쓰면 공유 서버의 로컬 계정으로 본다
            domain = IsNetworkPath(path) ? path.TrimStart('\\').Split('\\')[0] : ".";
        }
        if (!LogonUser(user, domain, password, LogonNewCredentials, ProviderWinNt50, out var token))
            throw new IOException($"로그온 실패: {new Win32Exception(Marshal.GetLastWin32Error()).Message}");
        return token;
    }

    private const int LogonNewCredentials = 9;
    private const int ProviderWinNt50 = 3;

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LogonUser(string user, string? domain, string password, int logonType, int provider, out SafeAccessTokenHandle token);

    private void Save(List<Stored> list)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(list, Json));
        File.Move(temp, _path, overwrite: true);
    }

    // DPAPI(LocalMachine): 이 컴퓨터에서만 복호화 가능
    private static string Protect(string plain)
    {
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.LocalMachine);
        return Convert.ToBase64String(bytes);
    }

    private static string Unprotect(string? encoded)
    {
        if (string.IsNullOrEmpty(encoded))
            return "";
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(encoded), null, DataProtectionScope.LocalMachine);
        return Encoding.UTF8.GetString(bytes);
    }
}
