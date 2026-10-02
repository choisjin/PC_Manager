using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using SharpCompress.Archives;
using SharpCompress.Common;
using SharpCompress.Readers;

namespace PcManager.Shared;

/// <summary>암호가 필요하거나 암호가 틀린 압축 파일</summary>
public sealed class ArchivePasswordException(string message) : Exception(message);

/// <summary>압축 안 경로가 대상 폴더 밖을 가리키는 등 내용이 올바르지 않은 압축 파일</summary>
public sealed class ArchiveContentException(string message) : Exception(message);

/// <summary>
/// 압축 파일을 폴더처럼 다룬다. 경로 "D:\logs\a.zip\2026\run1.txt"처럼 압축 파일 뒤에 내부 경로를 붙여 쓴다.
/// zip, 7z, rar, tar, 분할 zip(.zip.001…) 지원. 압축 안은 읽기 전용이다.
/// </summary>
public static class ArchiveBrowser
{
    /// <summary>listing.Error가 이 문구로 시작하면 대시보드가 암호를 묻는다</summary>
    public const string PasswordRequiredPrefix = "암호가 필요합니다";

    private static readonly string[] Extensions = [".zip", ".7z", ".rar", ".tar", ".tgz", ".tar.gz"];

    // 압축 파일 경로 → 사용자가 입력한 암호 (프로세스 메모리에만)
    private static readonly ConcurrentDictionary<string, string> Passwords = new(StringComparer.OrdinalIgnoreCase);

    private static readonly string CacheDir = Path.Combine(Path.GetTempPath(), "PcManagerArchiveCache");
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(1);

    static ArchiveBrowser()
    {
        // 윈도우에서 만든 zip은 파일 이름이 CP949인 경우가 많다
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public static bool IsArchiveName(string name)
    {
        var lower = name.ToLowerInvariant();
        if (Extensions.Any(lower.EndsWith))
            return true;
        // 분할 압축의 첫 조각 (우리 분할 압축: a.zip.001, 7-Zip 분할: a.7z.001)
        return lower.EndsWith(".zip.001") || lower.EndsWith(".7z.001");
    }

    public static void SetPassword(string archivePath, string password)
    {
        if (string.IsNullOrEmpty(password))
            Passwords.TryRemove(archivePath, out _);
        else
            Passwords[archivePath] = password;
    }

    /// <summary>실제로 없는 경로가 "압축 파일\내부 경로" 형태면 나눈다. 압축 파일 자체를 가리켜도 true (내부 경로 "").</summary>
    public static bool TrySplit(string path, out string archivePath, out string innerPath)
    {
        archivePath = "";
        innerPath = "";
        if (string.IsNullOrWhiteSpace(path))
            return false;
        var full = path.TrimEnd('\\', '/');
        if (Directory.Exists(full))
            return false;
        if (File.Exists(full))
        {
            if (!IsArchiveName(full))
                return false;
            archivePath = full;
            return true;
        }

        // 뒤에서부터 한 단계씩 올라가며 압축 파일을 찾는다
        var current = full;
        while (true)
        {
            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent))
                return false;
            if (File.Exists(parent))
            {
                if (!IsArchiveName(parent))
                    return false;
                archivePath = parent;
                innerPath = full[(parent.Length + 1)..].Replace('\\', '/');
                return true;
            }
            if (Directory.Exists(parent))
                return false;
            current = parent;
        }
    }

    /// <summary>압축 안 폴더의 목록. innerPath ""는 압축 파일의 최상위.</summary>
    public static DirectoryListing List(string archivePath, string innerPath)
    {
        var display = innerPath.Length == 0 ? archivePath : archivePath + "\\" + innerPath.Replace('/', '\\');
        var parent = innerPath.Length == 0
            ? Path.GetDirectoryName(archivePath) ?? ""
            : archivePath + (innerPath.Contains('/') ? "\\" + innerPath[..innerPath.LastIndexOf('/')].Replace('/', '\\') : "");
        try
        {
            using var archive = Open(archivePath);
            var prefix = innerPath.Length == 0 ? "" : innerPath + "/";
            var dirs = new Dictionary<string, DateTime?>(StringComparer.OrdinalIgnoreCase);
            var files = new Dictionary<string, FileEntry>(StringComparer.OrdinalIgnoreCase);
            var found = innerPath.Length == 0;
            foreach (var entry in archive.Entries)
            {
                var key = Normalize(entry.Key);
                if (key.Length == 0 || !key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    continue;
                found = true;
                var rest = key[prefix.Length..];
                if (rest.Length == 0)
                    continue;
                var slash = rest.IndexOf('/');
                if (slash >= 0)
                {
                    // 더 깊은 항목 → 바로 아래 폴더만 보여준다 (폴더 항목이 따로 없는 압축도 있다)
                    dirs.TryAdd(rest[..slash], null);
                }
                else if (entry.IsDirectory)
                {
                    dirs[rest] = ToUtc(entry.LastModifiedTime);
                }
                else
                {
                    files[rest] = new FileEntry(rest, display + "\\" + rest, false, entry.Size, ToUtc(entry.LastModifiedTime));
                }
            }
            if (!found)
                return new DirectoryListing(display, parent, [], "압축 파일 안에 그 폴더가 없습니다.", archivePath);

            var entries = dirs
                .Select(d => new FileEntry(d.Key, display + "\\" + d.Key, true, 0, d.Value))
                .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .Concat(files.Values.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase))
                .ToList();
            return new DirectoryListing(display, parent, entries, null, archivePath);
        }
        catch (Exception ex) when (IsReadError(ex))
        {
            return new DirectoryListing(display, parent, [], Describe(ex), archivePath);
        }
    }

    /// <summary>
    /// 압축 안 파일을 읽을 수 있게 임시 폴더에 풀어 그 경로를 돌려준다 (미리 보기·다운로드·복사용).
    /// 같은 항목은 한동안 재사용한다.
    /// </summary>
    public static string ExtractToCache(string archivePath, string innerPath)
    {
        Directory.CreateDirectory(CacheDir);
        CleanCache();

        var stamp = File.GetLastWriteTimeUtc(archivePath).Ticks;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{archivePath.ToLowerInvariant()}|{stamp}|{innerPath}")))[..32];
        var target = Path.Combine(CacheDir, hash + Path.GetExtension(innerPath));
        if (File.Exists(target))
        {
            File.SetLastWriteTimeUtc(target, DateTime.UtcNow); // 정리 대상에서 미룬다
            return target;
        }

        try
        {
            using var archive = Open(archivePath);
            var entry = archive.Entries.FirstOrDefault(e => !e.IsDirectory && string.Equals(Normalize(e.Key), innerPath, StringComparison.OrdinalIgnoreCase))
                ?? throw new FileNotFoundException($"압축 파일 안에 없습니다: {innerPath}");
            var temp = target + ".part";
            using (var source = entry.OpenEntryStream())
            using (var dest = File.Create(temp))
                source.CopyTo(dest);
            File.Move(temp, target, overwrite: true);
            return target;
        }
        catch (Exception ex) when (IsReadError(ex))
        {
            throw new IOException(Describe(ex), ex);
        }
    }

    /// <summary>
    /// 압축 안 항목(파일·폴더)을 destFolder에 푼다. entryPaths가 비면 전부.
    /// 고른 항목은 지금 보고 있는 압축 안 폴더(baseInner) 기준 이름으로 풀린다. 같은 이름이 있으면 "이름 (2)"처럼 피한다.
    /// </summary>
    /// <returns>(파일 수, 바이트)</returns>
    public static (int Files, long Bytes) Extract(
        string archivePath, IReadOnlyList<string> innerPaths, string destFolder, Action<int, long, int>? progress = null)
    {
        Directory.CreateDirectory(destFolder);
        var destRoot = Path.GetFullPath(destFolder).TrimEnd('\\') + "\\";
        try
        {
            using var archive = Open(archivePath);
            var all = archive.Entries.Where(e => !e.IsDirectory && Normalize(e.Key).Length > 0).ToList();

            // 풀 대상: (항목, 대상 경로)
            var plan = new List<(IArchiveEntry Entry, string Dest)>();
            var dirsToMake = new List<string>();
            if (innerPaths.Count == 0)
            {
                foreach (var e in all)
                    plan.Add((e, Normalize(e.Key)));
            }
            else
            {
                foreach (var selected in innerPaths.Select(p => p.Trim('/')).Where(p => p.Length > 0))
                {
                    var name = selected.Contains('/') ? selected[(selected.LastIndexOf('/') + 1)..] : selected;
                    var exact = all.FirstOrDefault(e => string.Equals(Normalize(e.Key), selected, StringComparison.OrdinalIgnoreCase));
                    if (exact is not null)
                    {
                        plan.Add((exact, UniqueName(destRoot, name)));
                        continue;
                    }
                    // 폴더: 하위 전부
                    var prefix = selected + "/";
                    var children = all.Where(e => Normalize(e.Key).StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToList();
                    var folderName = UniqueName(destRoot, name);
                    dirsToMake.Add(folderName);
                    foreach (var e in children)
                        plan.Add((e, folderName + "/" + Normalize(e.Key)[prefix.Length..]));
                }
            }

            foreach (var dir in dirsToMake)
                Directory.CreateDirectory(SafeJoin(destRoot, dir));

            var totalBytes = Math.Max(1, plan.Sum(p => p.Entry.Size));
            long done = 0;
            var files = 0;
            var lastPercent = -1;
            foreach (var (entry, relative) in plan)
            {
                var dest = SafeJoin(destRoot, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                using (var source = entry.OpenEntryStream())
                using (var output = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 81920))
                {
                    var buffer = new byte[81920];
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                        done += read;
                        var percent = (int)Math.Min(99, done * 100 / totalBytes);
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            progress?.Invoke(files, done, percent);
                        }
                    }
                }
                var modified = ToUtc(entry.LastModifiedTime);
                if (modified is not null)
                {
                    try { File.SetLastWriteTimeUtc(dest, modified.Value); } catch (IOException) { }
                }
                files++;
            }
            return (files, done);
        }
        catch (Exception ex) when (IsReadError(ex))
        {
            throw new IOException(Describe(ex), ex);
        }
    }

    private static IArchive Open(string archivePath)
    {
        var lower = archivePath.ToLowerInvariant();
        var options = new ReaderOptions
        {
            // zip은 UTF-8 표시가 없으면 윈도우 기본(CP949)으로 저장된 이름이다. tar·7z·rar는 유니코드
            ArchiveEncoding = lower.EndsWith(".zip") || lower.EndsWith(".zip.001")
                ? new ArchiveEncoding { Default = Cp949, CustomDecoder = DecodeZipName }
                : new ArchiveEncoding { Default = Encoding.UTF8 },
            Password = Passwords.TryGetValue(archivePath, out var pw) ? pw : null,
        };
        if (lower.EndsWith(".zip.001"))
        {
            // 우리 분할 압축은 zip을 바이트 단위로 자른 것 → 이어 붙여 하나의 zip으로 읽는다
            return ArchiveFactory.OpenArchive(new ConcatStream(VolumeParts(archivePath)), options);
        }
        if (lower.EndsWith(".7z.001"))
        {
            // 7-Zip 분할도 단순 분할이다
            return ArchiveFactory.OpenArchive(new ConcatStream(VolumeParts(archivePath)), options with { ExtensionHint = "7z" });
        }
        if (lower.EndsWith(".tar.gz") || lower.EndsWith(".tgz"))
        {
            // tar.gz는 압축을 한 번 풀어 둔 tar로 연다 (gzip은 중간부터 읽을 수 없다)
            return ArchiveFactory.OpenArchive(DecompressedTar(archivePath), options);
        }
        return ArchiveFactory.OpenArchive(archivePath, options);
    }

    private static string DecompressedTar(string archivePath)
    {
        Directory.CreateDirectory(CacheDir);
        CleanCache();
        var stamp = File.GetLastWriteTimeUtc(archivePath).Ticks;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{archivePath.ToLowerInvariant()}|{stamp}|tar")))[..32];
        var tar = Path.Combine(CacheDir, hash + ".tar");
        if (File.Exists(tar))
        {
            File.SetLastWriteTimeUtc(tar, DateTime.UtcNow);
            return tar;
        }
        var temp = tar + ".part";
        using (var source = new System.IO.Compression.GZipStream(File.OpenRead(archivePath), System.IO.Compression.CompressionMode.Decompress))
        using (var dest = File.Create(temp))
            source.CopyTo(dest);
        File.Move(temp, tar, overwrite: true);
        return tar;
    }

    // 정적 생성자에서 코드 페이지를 등록한 뒤에 만들어야 한다
    private static Encoding Cp949 => field ??= Encoding.GetEncoding(949);

    // UTF-8 표시가 있으면 UTF-8, 없으면 CP949 (윈도우 탐색기·알집 등으로 만든 zip)
    private static string DecodeZipName(byte[] bytes, int index, int count, EncodingType type) =>
        type == EncodingType.UTF8 ? Encoding.UTF8.GetString(bytes, index, count) : Cp949.GetString(bytes, index, count);

    private static List<string> VolumeParts(string first)
    {
        var basePath = first[..^4];
        var parts = new List<string>();
        for (var i = 1; ; i++)
        {
            var part = $"{basePath}.{i:D3}";
            if (!File.Exists(part))
                break;
            parts.Add(part);
        }
        return parts;
    }

    private static string Normalize(string? key)
    {
        var k = (key ?? "").Replace('\\', '/');
        // tar는 "./폴더/파일"처럼 저장되는 경우가 많다
        while (k.StartsWith("./", StringComparison.Ordinal))
            k = k[2..];
        k = k.Trim('/');
        return k == "." ? "" : k;
    }

    private static DateTime? ToUtc(DateTime? time) =>
        time is null ? null
        : time.Value.Kind == DateTimeKind.Utc ? time
        : DateTime.SpecifyKind(time.Value, DateTimeKind.Local).ToUniversalTime();

    private static string UniqueName(string destRoot, string name)
    {
        if (!File.Exists(destRoot + name) && !Directory.Exists(destRoot + name))
            return name;
        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 2; ; i++)
        {
            var candidate = $"{stem} ({i}){ext}";
            if (!File.Exists(destRoot + candidate) && !Directory.Exists(destRoot + candidate))
                return candidate;
        }
    }

    /// <summary>압축 안 경로가 "../" 등으로 대상 폴더 밖을 가리키지 못하게 막는다 (zip slip)</summary>
    private static string SafeJoin(string destRoot, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(destRoot, relative.Replace('/', '\\')));
        if (!full.StartsWith(destRoot, StringComparison.OrdinalIgnoreCase))
            throw new ArchiveContentException($"압축 안 경로가 올바르지 않아 풀 수 없습니다: {relative}");
        return full;
    }

    private static void CleanCache()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(CacheDir))
            {
                if (DateTime.UtcNow - File.GetLastWriteTimeUtc(file) > CacheLifetime)
                {
                    try { File.Delete(file); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
        }
        catch (IOException)
        {
            // 정리 실패는 무시
        }
    }

    private static bool IsReadError(Exception ex) =>
        ex.GetType().Namespace?.StartsWith("SharpCompress", StringComparison.Ordinal) == true
        || ex is IOException or UnauthorizedAccessException or InvalidOperationException or NotSupportedException
            or ArgumentException or System.Security.Cryptography.CryptographicException or SharpCompress.Common.CryptographicException or ArchiveException or InvalidFormatException
            or ArchivePasswordException or IndexOutOfRangeException;

    private static string Describe(Exception ex)
    {
        var text = ex.ToString();
        if (ex is System.Security.Cryptography.CryptographicException or SharpCompress.Common.CryptographicException
            || text.Contains("password", StringComparison.OrdinalIgnoreCase)
            || text.Contains("encrypt", StringComparison.OrdinalIgnoreCase))
            return PasswordRequiredPrefix + " (암호를 입력하거나, 입력한 암호가 틀렸습니다)";
        return ex is FileNotFoundException ? ex.Message : "압축 파일을 읽을 수 없습니다: " + ex.Message;
    }

    /// <summary>여러 조각 파일을 하나의 읽기 전용 스트림으로 이어 붙인다.</summary>
    private sealed class ConcatStream : Stream
    {
        private readonly List<FileStream> _parts;
        private readonly long[] _starts;
        private long _position;

        public ConcatStream(IReadOnlyList<string> paths)
        {
            _parts = [.. paths.Select(p => new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))];
            _starts = new long[_parts.Count];
            long offset = 0;
            for (var i = 0; i < _parts.Count; i++)
            {
                _starts[i] = offset;
                offset += _parts[i].Length;
            }
            Length = offset;
        }

        public override long Length { get; }
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;

        public override long Position
        {
            get => _position;
            set => _position = Math.Clamp(value, 0, Length);
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_position >= Length || count == 0)
                return 0;
            var index = Array.FindLastIndex(_starts, s => s <= _position);
            var part = _parts[index];
            part.Position = _position - _starts[index];
            var read = part.Read(buffer, offset, (int)Math.Min(count, part.Length - part.Position));
            _position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            Position = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => _position + offset,
                _ => Length + offset,
            };
            return _position;
        }

        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                foreach (var part in _parts)
                    part.Dispose();
            base.Dispose(disposing);
        }
    }
}
