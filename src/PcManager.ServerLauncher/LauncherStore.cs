using System.Text.Json;
using System.Text.Json.Serialization;

namespace PcManager.ServerLauncher;

/// <summary>
/// 런처 폴더 구성 (런처 exe가 있는 폴더 기준)
/// <code>
///   launcher.json              인스턴스 목록
///   server\                    공용 서버 바이너리 (모든 인스턴스가 같이 씀)
///   instances\이름\data        인스턴스별 DB·로그·결과 파일 (기본 위치)
///   instances\이름\server.log  서버 출력
/// </code>
/// </summary>
internal static class LauncherPaths
{
    public static string Root { get; } = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    public static string ConfigFile => Path.Combine(Root, "launcher.json");
    public static string ServerDirectory => Path.Combine(Root, "server");
    public static string ServerExe => Path.Combine(ServerDirectory, "PcManager.Server.exe");
    public static string InstancesDirectory => Path.Combine(Root, "instances");
    public static string InstanceDirectory(string name) => Path.Combine(InstancesDirectory, name);
    public static string DefaultDataDirectory(string name) => Path.Combine(InstanceDirectory(name), "data");
    public static string LogFile(string name) => Path.Combine(InstanceDirectory(name), "server.log");
}

[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
internal sealed class InstanceConfig
{
    /// <summary>이름 (폴더 이름으로도 씀, 바꿀 수 없음)</summary>
    public string Name { get; set; } = "";
    public int Port { get; set; }
    /// <summary>대시보드 HTTPS 포트. null이면 포트+1, 0이면 HTTPS 안 씀</summary>
    public int? HttpsPort { get; set; }
    /// <summary>비우면 instances\이름\data</summary>
    public string? DataDirectory { get; set; }
    /// <summary>런처가 켜질 때 자동 시작</summary>
    public bool AutoStart { get; set; } = true;

    /// <summary>실제 HTTPS 포트. 0이면 끔</summary>
    [JsonIgnore]
    public int ResolvedHttpsPort => HttpsPort ?? (Port < 65535 ? Port + 1 : 0);

    /// <summary>이 서버가 쓰는 포트들 (HTTP, HTTPS)</summary>
    [JsonIgnore]
    public IEnumerable<int> Ports => ResolvedHttpsPort > 0 ? [Port, ResolvedHttpsPort] : [Port];

    [JsonIgnore]
    public string ResolvedDataDirectory =>
        string.IsNullOrWhiteSpace(DataDirectory) ? LauncherPaths.DefaultDataDirectory(Name) : DataDirectory;
}

[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
internal sealed class LauncherConfig
{
    public List<InstanceConfig> Instances { get; set; } = [];
}

internal static class LauncherStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static LauncherConfig Load()
    {
        try
        {
            if (File.Exists(LauncherPaths.ConfigFile))
                return JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(LauncherPaths.ConfigFile)) ?? new();
        }
        catch (JsonException)
        {
            // 손상된 파일은 덮어쓰지 않도록 옆에 남겨 둔다
            File.Copy(LauncherPaths.ConfigFile, LauncherPaths.ConfigFile + ".broken", overwrite: true);
        }
        return new();
    }

    public static void Save(LauncherConfig config)
    {
        var temp = LauncherPaths.ConfigFile + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(config, JsonOptions));
        File.Move(temp, LauncherPaths.ConfigFile, overwrite: true);
    }
}
