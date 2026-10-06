using System.Diagnostics;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace PcManager.ServerLauncher;

/// <summary>
/// 공용 서버 바이너리(server 폴더) 관리: 설치된 버전 확인, GitHub 최신 버전 확인, 서버 zip에서 server 폴더 교체.
/// 서버 zip(PcManager-Server-버전.zip)은 server\ 아래에 서버·대시보드·에이전트 설치 파일이 들어 있다.
/// </summary>
internal static partial class ServerPackage
{
    public const string Repo = "choisjin/PC_Manager";

    private static readonly HttpClient Http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PcManager-ServerLauncher");
        return http;
    }

    private static string NewDirectory => LauncherPaths.ServerDirectory + ".new";
    private static string OldDirectory => LauncherPaths.ServerDirectory + ".old";
    private static string DownloadDirectory => Path.Combine(LauncherPaths.Root, "download");

    /// <summary>server 폴더의 서버 버전. 없으면 null</summary>
    public static Version? InstalledVersion()
    {
        var dll = Path.Combine(LauncherPaths.ServerDirectory, "PcManager.Server.dll");
        if (!File.Exists(dll))
            return null;
        var text = FileVersionInfo.GetVersionInfo(dll).FileVersion;
        return Version.TryParse(text, out var v) ? new Version(v.Major, v.Minor, Math.Max(v.Build, 0)) : null;
    }

    /// <summary>
    /// 최신 릴리스 버전. API 요청 한도(같은 IP에서 시간당 60회, 사무실 공용)를 쓰지 않도록
    /// /releases/latest 웹 주소의 리디렉션(…/tag/v1.2.3)으로 알아낸다
    /// </summary>
    public static async Task<Version> LatestVersionAsync(CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(15));
        using var response = await Http.GetAsync($"https://github.com/{Repo}/releases/latest", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        var location = response.Headers.Location?.ToString() ?? "";
        var match = TagRegex().Match(location);
        if (!match.Success || !Version.TryParse(match.Groups[1].Value, out var version))
            throw new InvalidOperationException($"최신 버전을 확인하지 못했습니다 (HTTP {(int)response.StatusCode})");
        return version;
    }

    /// <summary>GitHub에서 서버 zip을 받는다. 진행률은 0~1</summary>
    public static async Task<string> DownloadAsync(Version version, IProgress<double> progress, CancellationToken ct)
    {
        var v = version.ToString(3);
        var url = $"https://github.com/{Repo}/releases/download/v{v}/PcManager-Server-{v}.zip";
        Directory.CreateDirectory(DownloadDirectory);
        var path = Path.Combine(DownloadDirectory, $"PcManager-Server-{v}.zip");

        // 릴리스 파일은 다른 호스트로 리디렉션된다 (자동 리디렉션을 껐으므로 직접 따라감)
        var target = new Uri(url);
        for (var hop = 0; hop < 5; hop++)
        {
            using var response = await Http.GetAsync(target, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.Headers.Location is { } next && (int)response.StatusCode is >= 300 and < 400)
            {
                target = next.IsAbsoluteUri ? next : new Uri(target, next);
                continue;
            }
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"다운로드 실패 (HTTP {(int)response.StatusCode}): {url}");

            var total = response.Content.Headers.ContentLength;
            await using var source = await response.Content.ReadAsStreamAsync(ct);
            await using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
            var buffer = new byte[81920];
            long done = 0;
            int read;
            while ((read = await source.ReadAsync(buffer, ct)) > 0)
            {
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                if (total > 0)
                    progress.Report((double)done / total.Value);
            }
            return path;
        }
        throw new InvalidOperationException("리디렉션이 너무 많습니다: " + url);
    }

    /// <summary>zip의 server 폴더를 server.new에 푼다. 풀린 서버 버전을 돌려준다</summary>
    public static Version? Extract(string zipPath)
    {
        if (Directory.Exists(NewDirectory))
            Directory.Delete(NewDirectory, recursive: true);
        Directory.CreateDirectory(NewDirectory);
        var root = Path.GetFullPath(NewDirectory) + Path.DirectorySeparatorChar;

        using (var zip = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in zip.Entries)
            {
                // Windows PowerShell의 Compress-Archive는 구분자로 \를 쓰기도 한다
                var name = entry.FullName.Replace('\\', '/');
                if (!name.StartsWith("server/", StringComparison.OrdinalIgnoreCase))
                    continue;
                var relative = name["server/".Length..];
                if (relative.Length == 0)
                    continue;
                var dest = Path.GetFullPath(Path.Combine(NewDirectory, relative));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (name.EndsWith('/'))
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, overwrite: true);
            }
        }

        var dll = Path.Combine(NewDirectory, "PcManager.Server.dll");
        if (!File.Exists(Path.Combine(NewDirectory, "PcManager.Server.exe")) || !File.Exists(dll))
        {
            Directory.Delete(NewDirectory, recursive: true);
            throw new InvalidOperationException("zip 안에 서버(server\\PcManager.Server.exe)가 없습니다. PcManager-Server-버전.zip 파일인지 확인하세요.");
        }
        return Version.TryParse(FileVersionInfo.GetVersionInfo(dll).FileVersion, out var v) ? new Version(v.Major, v.Minor, Math.Max(v.Build, 0)) : null;
    }

    /// <summary>server.new를 server로 바꾼다. 모든 인스턴스가 꺼진 뒤 호출해야 한다</summary>
    public static async Task SwapAsync()
    {
        if (Directory.Exists(OldDirectory))
            Directory.Delete(OldDirectory, recursive: true);
        if (Directory.Exists(LauncherPaths.ServerDirectory))
        {
            // 방금 끝난 프로세스의 파일 잠금이 늦게 풀릴 수 있어 몇 번 다시 시도
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    Directory.Move(LauncherPaths.ServerDirectory, OldDirectory);
                    break;
                }
                catch (IOException) when (attempt < 10)
                {
                    await Task.Delay(1000);
                }
                catch (UnauthorizedAccessException) when (attempt < 10)
                {
                    await Task.Delay(1000);
                }
            }
        }
        Directory.Move(NewDirectory, LauncherPaths.ServerDirectory);
        try
        {
            if (Directory.Exists(OldDirectory))
                Directory.Delete(OldDirectory, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 이전 버전 폴더는 다음 업데이트 때 다시 지운다
        }
    }

    public static void CleanupDownloads()
    {
        try
        {
            if (Directory.Exists(DownloadDirectory))
                Directory.Delete(DownloadDirectory, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    [GeneratedRegex(@"/tag/v?([0-9]+(?:\.[0-9]+)+)$")]
    private static partial Regex TagRegex();
}
