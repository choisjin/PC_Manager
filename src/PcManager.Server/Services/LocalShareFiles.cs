using System.IO.Compression;
using PcManager.Server.Contracts;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 서버가 직접 접근하는 공유 폴더의 파일 작업. 에이전트(SignalR) 대신 서버 로컬 파일시스템으로 처리한다.
/// 모든 경로는 공유 루트 하위로 제한한다(경로 이탈 방지).
/// </summary>
public class LocalShareFiles(ILogger<LocalShareFiles> logger)
{
    private const int MaxListEntries = 5000;

    public DirectoryListing ListDirectory(SharedFolder share, string? path)
    {
        try
        {
            var root = RootOf(share);
            var target = ResolveWithin(share, path);
            var dir = new DirectoryInfo(target);
            if (!dir.Exists)
                return new DirectoryListing(target, null, [], "폴더가 없습니다.");

            var entries = dir
                .EnumerateFileSystemInfos("*", new EnumerationOptions
                {
                    IgnoreInaccessible = true,
                    AttributesToSkip = FileAttributes.System,
                })
                .Select(info => info is FileInfo file
                    ? new FileEntry(file.Name, file.FullName, false, file.Length, file.LastWriteTimeUtc, (file.Attributes & FileAttributes.Hidden) != 0)
                    : new FileEntry(info.Name, info.FullName, true, 0, info.LastWriteTimeUtc, (info.Attributes & FileAttributes.Hidden) != 0))
                .Take(MaxListEntries)
                .OrderByDescending(e => e.IsDirectory)
                .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            // 공유 루트 위로는 못 올라가게 한다
            var parent = dir.Parent;
            var parentPath = parent is not null && IsWithin(root, parent.FullName) ? parent.FullName : null;
            return new DirectoryListing(dir.FullName, parentPath, entries, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new DirectoryListing(path ?? "", null, [], ex.Message);
        }
    }

    public FileOpResult PerformFileOp(SharedFolder share, FileOpRequest request)
    {
        try
        {
            var path = ResolveWithin(share, request.Path);
            switch (request.Op)
            {
                case FileOpKind.Copy:
                {
                    var target = ResolveWithin(share, Require(request.Target, "대상 폴더"));
                    var dest = UniqueChildPath(target, Path.GetFileName(path.TrimEnd('\\', '/')));
                    CopyRecursive(path, dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Move:
                {
                    var target = ResolveWithin(share, Require(request.Target, "대상 폴더"));
                    var dest = UniqueChildPath(target, Path.GetFileName(path.TrimEnd('\\', '/')));
                    MovePath(path, dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Delete:
                    DeletePath(path);
                    return new FileOpResult(true, null, null);
                case FileOpKind.CreateDirectory:
                {
                    var dest = UniqueChildPath(path, CleanName(Require(request.Target, "폴더 이름")));
                    Directory.CreateDirectory(dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Rename:
                {
                    var parent = Path.GetDirectoryName(path.TrimEnd('\\', '/')) ?? throw new IOException("상위 폴더를 찾을 수 없습니다.");
                    var dest = Path.Combine(parent, CleanName(Require(request.Target, "새 이름")));
                    if (!string.Equals(dest, path, StringComparison.OrdinalIgnoreCase) && Exists(dest))
                        throw new IOException("같은 이름이 이미 있습니다.");
                    MovePath(path, dest);
                    return new FileOpResult(true, null, dest);
                }
                default:
                    return new FileOpResult(false, "지원하지 않는 작업입니다.", null);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            logger.LogWarning("공유 폴더 파일 조작 실패 {Op} {Path}: {Message}", request.Op, request.Path, ex.Message);
            return new FileOpResult(false, ex.Message, null);
        }
    }

    /// <summary>공유 폴더 안의 파일을 읽기용으로 연다 (다운로드/미디어 스트리밍). 없으면 null.</summary>
    public FileStream? OpenRead(SharedFolder share, string path)
    {
        try
        {
            var full = ResolveWithin(share, path);
            if (!File.Exists(full))
                return null;
            return new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, useAsync: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    public string ResolveWithin(SharedFolder share, string? path)
    {
        var root = RootOf(share);
        if (string.IsNullOrWhiteSpace(path))
            return root;
        var full = Path.GetFullPath(path);
        if (!IsWithin(root, full))
            throw new UnauthorizedAccessException("공유 폴더 밖의 경로입니다.");
        return full;
    }

    /// <summary>업로드 받은 내용을 공유 폴더에 저장한다. 저장한 전체 경로를 반환한다.</summary>
    public async Task<string> SaveUploadAsync(SharedFolder share, string destinationPath, Stream content, CancellationToken ct)
    {
        var full = ResolveWithin(share, destinationPath);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var tempPath = full + ".pcm-upload";
        await using (var file = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            await content.CopyToAsync(file, ct);
        File.Move(tempPath, full, overwrite: true);
        return full;
    }

    /// <summary>선택 항목을 하나의 zip으로 압축한다 (공유 폴더 안, 서버에서 직접 수행). zip 크기를 반환한다.</summary>
    public long Compress(SharedFolder share, IReadOnlyList<string> paths, string destinationFolder, string archiveName)
    {
        var destFolder = ResolveWithin(share, destinationFolder);
        Directory.CreateDirectory(destFolder);
        var finalPath = UniqueChildPath(destFolder, EnsureZipName(archiveName));
        var tempPath = finalPath + ".pcm-zip";

        var files = new List<(string Full, string Entry)>();
        foreach (var raw in paths)
        {
            var p = ResolveWithin(share, raw.TrimEnd('\\', '/'));
            if (Directory.Exists(p))
            {
                var baseName = Path.GetFileName(p);
                foreach (var f in Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories))
                    files.Add((f, baseName + "/" + Path.GetRelativePath(p, f).Replace('\\', '/')));
            }
            else if (File.Exists(p))
            {
                files.Add((p, Path.GetFileName(p)));
            }
            else
            {
                throw new FileNotFoundException($"항목이 없습니다: {p}");
            }
        }

        try
        {
            using (var zipStream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920))
            using (var zip = new ZipArchive(zipStream, ZipArchiveMode.Create))
            {
                foreach (var (full, entryName) in files)
                {
                    var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
                    using var entryStream = entry.Open();
                    using var source = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    source.CopyTo(entryStream);
                }
            }
            File.Move(tempPath, finalPath, overwrite: false);
            return new FileInfo(finalPath).Length;
        }
        catch
        {
            try
            {
                if (File.Exists(tempPath))
                    File.Delete(tempPath);
            }
            catch (IOException) { /* 무시 */ }
            throw;
        }
    }

    private static string RootOf(SharedFolder share) => Path.GetFullPath(share.Path).TrimEnd('\\', '/');

    private static bool IsWithin(string root, string full)
    {
        var normalized = full.TrimEnd('\\', '/');
        return normalized.Equals(root, StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith(root + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static string EnsureZipName(string name)
    {
        var clean = CleanName(name);
        return clean.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ? clean : clean + ".zip";
    }

    private static string Require(string? value, string what) =>
        string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{what}이(가) 필요합니다.") : value;

    private static string CleanName(string name)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0 || trimmed.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new ArgumentException("이름에 사용할 수 없는 문자가 있습니다.");
        return trimmed;
    }

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    private static string UniqueChildPath(string folder, string name)
    {
        var candidate = Path.Combine(folder, name);
        if (!Exists(candidate))
            return candidate;
        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 2; i < 10000; i++)
        {
            candidate = Path.Combine(folder, $"{stem} ({i}){ext}");
            if (!Exists(candidate))
                return candidate;
        }
        throw new IOException("겹치지 않는 이름을 만들 수 없습니다.");
    }

    private static void CopyRecursive(string source, string dest)
    {
        if (Directory.Exists(source))
        {
            Directory.CreateDirectory(dest);
            foreach (var file in Directory.EnumerateFiles(source))
                File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: false);
            foreach (var dir in Directory.EnumerateDirectories(source))
                CopyRecursive(dir, Path.Combine(dest, Path.GetFileName(dir)));
        }
        else if (File.Exists(source))
        {
            File.Copy(source, dest, overwrite: false);
        }
        else
        {
            throw new FileNotFoundException($"원본이 없습니다: {source}");
        }
    }

    private static void MovePath(string source, string dest)
    {
        try
        {
            if (Directory.Exists(source))
                Directory.Move(source, dest);
            else
                File.Move(source, dest);
        }
        catch (IOException)
        {
            CopyRecursive(source, dest);
            DeletePath(source);
        }
    }

    private static void DeletePath(string path)
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else if (File.Exists(path))
            File.Delete(path);
        else
            throw new FileNotFoundException($"대상이 없습니다: {path}");
    }
}
