namespace PcManager.Server.Contracts;

/// <summary>
/// 결과 확인 탭: PC별로 미리 정해 둔 결과 폴더. 날짜를 고르면 이 폴더들에서 그날 실행을 찾아 불러온다
/// </summary>
/// <param name="Mode">결과 형식: "ats" · "rfw"</param>
/// <param name="ResultDir">Result 파일(CSV)을 찾을 폴더 (하위 폴더까지)</param>
/// <param name="Pattern">Result 파일 이름 패턴 (비우면 *.csv)</param>
/// <param name="VideoDir">영상 폴더 (하위 폴더까지, 실행 시간에 걸친 영상을 고른다)</param>
/// <param name="ImageDir">결과 이미지 폴더 (고정 폴더, 또는 실행마다 날짜 폴더가 생기는 상위 폴더)</param>
/// <param name="RefDir">원본 이미지 폴더 (고정)</param>
/// <param name="UpdatedBy">마지막으로 바꾼 사용자 id</param>
public record ResultProfileView(
    string Mode, string ResultDir, string? Pattern, string? VideoDir, string? ImageDir, string? RefDir,
    string? UpdatedBy, DateTime? UpdatedAt);

/// <summary>
/// 결과 폴더 프리셋: 이름 붙여 저장해 둔 결과 폴더 묶음. PC의 결과 폴더를 정할 때 골라 바로 채운다 (모든 사용자 공용, 고칠 수 있음)
/// </summary>
/// <param name="Name">화면에 보이는 이름</param>
public record ResultPresetView(
    string Name, string Mode, string ResultDir, string? Pattern, string? VideoDir, string? ImageDir, string? RefDir,
    string? UpdatedBy, DateTime? UpdatedAt);

/// <param name="Profiles">agentId → 결과 폴더</param>
/// <param name="Presets">프리셋 id → 프리셋. 한 번도 저장한 적 없으면(null) 기본 프리셋(ATS·RFW)</param>
public record ResultProfilesView(
    IReadOnlyDictionary<string, ResultProfileView> Profiles,
    IReadOnlyDictionary<string, ResultPresetView>? Presets = null);
