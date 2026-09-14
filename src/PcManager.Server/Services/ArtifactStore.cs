using System.Xml;
using System.Xml.Linq;

namespace PcManager.Server.Services;

public record JUnitSummary(int Total, int Failed, int Skipped);

/// <summary>결과 파일과 PC로 보낼 파일을 디스크에 저장한다.</summary>
public class ArtifactStore(AppPaths paths)
{
    private const long MaxJUnitParseBytes = 50 * 1024 * 1024;

    /// <summary>수집/가져온 파일: data/artifacts/{transferId}/{상대 경로}</summary>
    public string GetArtifactPath(string transferId, string relativePath)
    {
        var root = Path.GetFullPath(Path.Combine(paths.DataDirectory, "artifacts", ValidateId(transferId)))
            + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(Path.Combine(root, NormalizeRelativePath(relativePath)));
        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("잘못된 파일 경로입니다.");
        return fullPath;
    }

    /// <summary>PC로 보낼 파일: data/transfers/{transferId}/content</summary>
    public string GetPushContentPath(string transferId) =>
        Path.Combine(paths.DataDirectory, "transfers", ValidateId(transferId), "content");

    /// <summary>'/' 구분 상대 경로로 정규화한다. 절대 경로나 '..'는 거부한다.</summary>
    public static string NormalizeRelativePath(string relativePath)
    {
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        if (normalized.Length == 0
            || normalized.Contains(':')
            || normalized.Split('/').Any(segment => segment is "" or "." or ".."))
        {
            throw new ArgumentException("잘못된 파일 경로입니다.");
        }
        return normalized;
    }

    /// <returns>저장된 바이트 수</returns>
    public async Task<long> SaveAsync(string path, Stream content, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tempPath = path + ".uploading";
        try
        {
            await using (var file = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            {
                await content.CopyToAsync(file, ct);
            }
            File.Move(tempPath, path, overwrite: true);
            return new FileInfo(path).Length;
        }
        finally
        {
            if (File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    /// <summary>JUnit XML이면 testcase 기준으로 집계한다. 형식이 아니면 null.</summary>
    public static JUnitSummary? TryParseJUnit(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > MaxJUnitParseBytes
            || !file.Extension.Equals(".xml", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        try
        {
            // 기본 설정은 DTD를 금지해 XXE를 막는다
            using var reader = XmlReader.Create(path, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit });
            var root = XDocument.Load(reader).Root;
            if (root is null || root.Name.LocalName is not ("testsuites" or "testsuite"))
                return null;

            var cases = root.DescendantsAndSelf().Where(e => e.Name.LocalName == "testcase").ToList();
            var failed = cases.Count(c => c.Elements().Any(e => e.Name.LocalName is "failure" or "error"));
            var skipped = cases.Count(c => c.Elements().Any(e => e.Name.LocalName == "skipped"));
            return new JUnitSummary(cases.Count, failed, skipped);
        }
        catch (XmlException)
        {
            return null;
        }
    }

    private static string ValidateId(string id) =>
        Guid.TryParseExact(id, "N", out _) ? id : throw new ArgumentException("잘못된 ID 형식입니다.");
}
