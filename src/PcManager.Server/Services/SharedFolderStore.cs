using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>서버가 직접 접근하는 공유 폴더 목록을 저장한다 (모든 대시보드 공유). 네트워크 자격증명은 DPAPI로 암호화 저장.</summary>
public class SharedFolderStore(AppPaths paths, ILogger<SharedFolderStore> logger)
{
    private const int MaxShares = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "shared-folders.json");

    /// <summary>저장용 내부 모델 (비밀번호는 암호화된 상태)</summary>
    private record Stored(string Id, string Name, string Path, string? Username, string? ProtectedPassword);

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

    private static SharedFolder ToView(Stored s) => new(s.Id, s.Name, s.Path, s.Username);

    public SharedFoldersView Load()
    {
        lock (_lock)
        {
            return new SharedFoldersView(LoadUnlocked().Select(ToView).ToList());
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

    /// <summary>공유 폴더 추가. 자격증명이 있으면 먼저 네트워크 로그온 후, 접근 가능한지 확인한다.</summary>
    public SharedFolder Add(string name, string path, string? username, string? password)
    {
        var cleanPath = path.Trim().TrimEnd('\\', '/');
        if (string.IsNullOrWhiteSpace(cleanPath))
            throw new ArgumentException("경로를 입력하세요.");

        var hasCredentials = !string.IsNullOrWhiteSpace(username);
        if (hasCredentials)
            NetworkShare.Connect(cleanPath, username!, password ?? "");

        if (!Directory.Exists(cleanPath))
            throw new DirectoryNotFoundException($"폴더에 접근할 수 없습니다: {cleanPath}");

        var cleanName = string.IsNullOrWhiteSpace(name)
            ? (Path.GetFileName(cleanPath) is { Length: > 0 } leaf ? leaf : cleanPath)
            : name.Trim();

        var stored = new Stored(
            Guid.NewGuid().ToString("N"),
            cleanName,
            cleanPath,
            hasCredentials ? username!.Trim() : null,
            hasCredentials ? Protect(password ?? "") : null);

        lock (_lock)
        {
            var list = LoadUnlocked();
            if (list.Count >= MaxShares)
                throw new InvalidOperationException("공유 폴더가 너무 많습니다.");
            var existing = list.FirstOrDefault(s => string.Equals(s.Path, cleanPath, StringComparison.OrdinalIgnoreCase));
            if (existing is not null)
                return ToView(existing);
            list.Add(stored);
            Save(list);
        }
        return ToView(stored);
    }

    public SharedFoldersView Remove(string id)
    {
        lock (_lock)
        {
            var list = LoadUnlocked().Where(s => s.Id != id).ToList();
            Save(list);
            return new SharedFoldersView(list.Select(ToView).ToList());
        }
    }

    /// <summary>서버 시작 시, 자격증명이 있는 공유에 다시 로그온한다 (best-effort).</summary>
    public void ReconnectAll()
    {
        List<Stored> list;
        lock (_lock)
        {
            list = LoadUnlocked();
        }
        foreach (var s in list.Where(s => !string.IsNullOrWhiteSpace(s.Username)))
        {
            try
            {
                NetworkShare.Connect(s.Path, s.Username!, Unprotect(s.ProtectedPassword));
            }
            catch (Exception ex) when (ex is IOException or CryptographicException or FormatException)
            {
                logger.LogWarning("공유 서버 재연결 실패 {Path}: {Message}", s.Path, ex.Message);
            }
        }
    }

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
