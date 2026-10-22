using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// PC별 결과 폴더(결과 확인 탭)와 결과 폴더 프리셋을 서버에 저장한다 (모든 대시보드 공유).
/// PC·프리셋 하나씩 바꿔 서로 덮어쓰지 않는다.
/// </summary>
public class ResultProfileStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>
    /// 처음 쓰는 서버의 기본 프리셋 (사용자가 고치거나 지울 수 있다)
    ///   ATS: 설치 드라이브의 excelrunner_report (날짜 폴더 안 CSV·이미지 폴더), 원본 이미지는 그 안 captured_image
    ///   RFW: 리눅스 cdc 계정 기준 (excel_report의 CSV, RF_TESTLOG/A_IVI2/(날짜 폴더)/Image, 녹화는 ~/Videos)
    /// </summary>
    private static readonly IReadOnlyDictionary<string, ResultPresetView> DefaultPresets = new Dictionary<string, ResultPresetView>
    {
        ["ats-default"] = new("ATS (D 드라이브)", "ats",
            @"D:\excelrunner_report", null, null, null, @"D:\excelrunner_report\captured_image", null, null),
        ["rfw-default"] = new("RFW (리눅스 cdc)", "rfw",
            "/home/cdc/workspace/rnavn_project/excel_report", null, "/home/cdc/Videos",
            "/home/cdc/workspace/RF_TESTLOG/A_IVI2", "/home/cdc/workspace/rnavn_project/Image", null, null),
    };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "result-profiles.json");

    private static ResultProfilesView Empty() => new(new Dictionary<string, ResultProfileView>());

    public ResultProfilesView Load()
    {
        lock (_lock)
            return Read();
    }

    /// <summary>PC 하나의 결과 폴더를 바꾼다 (null이면 지운다)</summary>
    public ResultProfilesView Set(string agentId, ResultProfileView? profile, string? userId)
    {
        lock (_lock)
        {
            var current = Read();
            var profiles = new Dictionary<string, ResultProfileView>(current.Profiles);
            if (profile is null)
                profiles.Remove(agentId);
            else
                profiles[agentId] = Normalize(profile, userId);
            return Write(current with { Profiles = profiles });
        }
    }

    /// <summary>프리셋 하나를 바꾼다 (null이면 지운다)</summary>
    public ResultProfilesView SetPreset(string presetId, ResultPresetView? preset, string? userId)
    {
        lock (_lock)
        {
            var current = Read();
            var presets = new Dictionary<string, ResultPresetView>(current.Presets!);
            if (preset is null)
                presets.Remove(presetId);
            else
                presets[presetId] = Normalize(preset, userId);
            return Write(current with { Presets = presets });
        }
    }

    private ResultProfilesView Write(ResultProfilesView saved)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tempPath = _path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(saved, Json));
        File.Move(tempPath, _path, overwrite: true);
        return saved;
    }

    /// <summary>저장된 값. 프리셋을 한 번도 저장하지 않았으면 기본 프리셋을 채운다</summary>
    private ResultProfilesView Read()
    {
        var view = Empty();
        if (File.Exists(_path))
        {
            try
            {
                view = JsonSerializer.Deserialize<ResultProfilesView>(File.ReadAllText(_path), Json) ?? Empty();
            }
            catch (JsonException)
            {
                view = Empty();
            }
        }
        return view.Presets is null ? view with { Presets = DefaultPresets } : view;
    }

    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>폴더 끝의 / \ 는 뗀다 (드라이브 루트 "D:\", 리눅스 루트 "/"는 그대로)</summary>
    private static string? CleanDir(string? s)
    {
        var dir = Clean(s);
        if (dir is null)
            return null;
        var trimmed = dir.TrimEnd('/', '\\');
        return trimmed.Length == 0 || trimmed.EndsWith(':') ? dir : trimmed;
    }

    private static ResultProfileView Normalize(ResultProfileView p, string? userId) => new(
        p.Mode == "rfw" ? "rfw" : "ats",
        CleanDir(p.ResultDir) ?? "",
        Clean(p.Pattern),
        CleanDir(p.VideoDir),
        CleanDir(p.ImageDir),
        CleanDir(p.RefDir),
        userId,
        DateTime.UtcNow);

    private static ResultPresetView Normalize(ResultPresetView p, string? userId) => new(
        p.Name.Trim(),
        p.Mode == "rfw" ? "rfw" : "ats",
        CleanDir(p.ResultDir) ?? "",
        Clean(p.Pattern),
        CleanDir(p.VideoDir),
        CleanDir(p.ImageDir),
        CleanDir(p.RefDir),
        userId,
        DateTime.UtcNow);
}
