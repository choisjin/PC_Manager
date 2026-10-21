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

/// <param name="Profiles">agentId → 결과 폴더</param>
public record ResultProfilesView(IReadOnlyDictionary<string, ResultProfileView> Profiles);
