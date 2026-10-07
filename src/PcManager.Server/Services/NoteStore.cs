using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 메모 저장소 (notes.json). 공유 메모는 누구나 보고 고치며, 개인 메모는 만든 사람만 본다.
/// 내용은 대시보드가 정리한 HTML(글자·줄바꿈·목록·이미지)이며, 이미지는 note-images 폴더에 따로 둔다.
/// 동시에 고치면 마지막 저장이 이기지 않도록 기준 수정 시각(baseUpdatedAt)이 다르면 거절한다.
/// </summary>
public class NoteStore(AppPaths paths)
{
    public const string Shared = "shared";
    public const string Personal = "personal";

    private const int MaxContentLength = 500_000;
    private const int MaxTitleLength = 80;
    private const long MaxImageBytes = 15 * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Dictionary<string, string> ImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["image/jpeg"] = ".jpg",
        ["image/png"] = ".png",
        ["image/webp"] = ".webp",
        ["image/gif"] = ".gif",
    };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "notes.json");
    private Dictionary<string, NoteView>? _notes;

    public string ImageDirectory { get; } = Path.Combine(paths.DataDirectory, "note-images");

    /// <summary>이 사용자가 볼 수 있는 메모 (최근 수정 순)</summary>
    public IReadOnlyList<NoteView> ListFor(string userId)
    {
        lock (_lock)
        {
            return Notes().Values.Where(n => CanSee(n, userId)).OrderByDescending(n => n.UpdatedAt).ToList();
        }
    }

    public NoteView Create(string userId, string scope)
    {
        if (scope is not (Shared or Personal))
            throw new ArgumentException("메모 종류가 올바르지 않습니다.");
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            var note = new NoteView(Guid.NewGuid().ToString("N"), scope, userId, "", "", now, now, userId);
            Notes()[note.Id] = note;
            Save();
            return note;
        }
    }

    /// <exception cref="NoteConflictException">그 사이 다른 곳에서 고쳤음</exception>
    public NoteView Update(string userId, string id, string? title, string? content, DateTime? baseUpdatedAt)
    {
        content ??= "";
        if (content.Length > MaxContentLength)
            throw new ArgumentException("메모가 너무 깁니다.");
        title = (title ?? "").Trim();
        if (title.Length > MaxTitleLength)
            title = title[..MaxTitleLength];
        lock (_lock)
        {
            var note = Find(id, userId);
            if (baseUpdatedAt is { } basis && Math.Abs((note.UpdatedAt - basis.ToUniversalTime()).TotalMilliseconds) > 1)
                throw new NoteConflictException(note);
            var updated = note with { Title = title, Content = content, UpdatedAt = DateTime.UtcNow, UpdatedBy = userId };
            Notes()[id] = updated;
            Save();
            return updated;
        }
    }

    public NoteView Delete(string userId, string id)
    {
        lock (_lock)
        {
            var note = Find(id, userId);
            Notes().Remove(id);
            Save();
            return note;
        }
    }

    /// <summary>이미지 저장 → 대시보드에서 쓸 주소</summary>
    public async Task<string> SaveImageAsync(Stream body, string? contentType, CancellationToken ct)
    {
        var type = (contentType ?? "").Split(';')[0].Trim();
        if (!ImageTypes.TryGetValue(type, out var extension))
            throw new ArgumentException("이미지(JPEG·PNG·WebP·GIF)만 넣을 수 있습니다.");
        Directory.CreateDirectory(ImageDirectory);
        var name = Guid.NewGuid().ToString("N") + extension;
        var path = Path.Combine(ImageDirectory, name);
        await using (var file = File.Create(path))
        {
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await body.ReadAsync(buffer, ct)) > 0)
            {
                total += read;
                if (total > MaxImageBytes)
                {
                    file.Close();
                    File.Delete(path);
                    throw new ArgumentException("이미지가 너무 큽니다 (15MB까지).");
                }
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
            }
        }
        return ImageUrl(name);
    }

    public static string ImageUrl(string name) => $"/api/notes/images/{name}";

    /// <summary>저장된 이미지 파일 (이름 검사 포함). 없으면 null</summary>
    public (string Path, string ContentType)? FindImage(string name)
    {
        if (name.Length > 64 || name.Any(c => !(char.IsAsciiLetterOrDigit(c) || c == '.')))
            return null;
        var path = Path.Combine(ImageDirectory, name);
        if (!File.Exists(path))
            return null;
        var type = ImageTypes.FirstOrDefault(kv => kv.Value.Equals(Path.GetExtension(name), StringComparison.OrdinalIgnoreCase)).Key;
        return type is null ? null : (path, type);
    }

    private static bool CanSee(NoteView note, string userId) => note.Scope == Shared || note.OwnerId == userId;

    private NoteView Find(string id, string userId)
    {
        if (!Notes().TryGetValue(id, out var note) || !CanSee(note, userId))
            throw new KeyNotFoundException("메모를 찾을 수 없습니다.");
        return note;
    }

    private Dictionary<string, NoteView> Notes()
    {
        if (_notes is not null)
            return _notes;
        _notes = [];
        try
        {
            if (File.Exists(_path))
                foreach (var note in JsonSerializer.Deserialize<List<NoteView>>(File.ReadAllText(_path), Json) ?? [])
                    _notes[note.Id] = note;
        }
        catch (JsonException)
        {
            // 깨진 파일은 덮어쓰지 않도록 옆에 남긴다
            File.Copy(_path, _path + ".broken", overwrite: true);
        }
        return _notes;
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(Notes().Values.ToList(), Json));
        File.Move(temp, _path, overwrite: true);
    }
}

public class NoteConflictException(NoteView current) : Exception("다른 곳에서 먼저 고쳤습니다.")
{
    public NoteView Current { get; } = current;
}
