namespace PcManager.Server.Services;

/// <summary>
/// 사람별로 켜고 끄는 대시보드 기능 id (web/src/perms.ts 의 FEATURES 와 같게).
/// 프로젝트 관리자는 전부 쓸 수 있다. 화면에서만 숨긴다 (서버 API는 검사하지 않음).
/// </summary>
public static class Features
{
    public static readonly IReadOnlyList<string> All =
    [
        "files",      // PC Manager 탭 (파일 탐색)
        "state",      // State 탭
        "history",    // History 탭
        "fileWrite",  // 파일 변경: 새 폴더·붙여넣기·이동·이름 바꾸기·삭제·올리기·압축·편집 저장
        "download",   // 가져오기·다운로드 링크·내 PC 프로그램으로 열기
        "remote",     // 원격조작
        "terminal",   // 터미널
        "results",    // 결과 확인
        "pcManage",   // PC 관리: 상태·별칭·PIN·PC 목록 폴더·프로젝트 배정·목록에서 삭제
    ];

    public static IReadOnlyList<string> Clean(IEnumerable<string>? features)
    {
        var set = (features ?? []).ToHashSet();
        return All.Where(set.Contains).ToList();
    }
}
