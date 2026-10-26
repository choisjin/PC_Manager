using System.Text.Json;
using PcManager.Shared;

namespace PcManager.Server.Contracts;

/// <summary>
/// 결과 확인 예약 분석: 녹화·테스트가 진행 중일 때 화면 영역·제외 구간·크롭 이미지를 미리 정해 두면, 그 시각에 서버가
/// 영상 목록을 다시 모아(같은 폴더에 그 뒤 저장된 영상까지 — 사이클마다 나눠 저장해도) 테스트 PC 에이전트에서 분석을 시작한다.
/// 시작한 분석은 결과 확인 작업(ResultJobView)이 된다
/// </summary>
/// <param name="At">시작할 시각 (UTC). 그때 PC가 오프라인이면 다시 연결될 때 시작</param>
/// <param name="Videos">예약할 때 고른 영상 (예약 시각에 같은 폴더에서 그 뒤 저장된 영상을 더한다)</param>
/// <param name="State">pending · started · failed</param>
/// <param name="StartedVideos">시작할 때 모은 영상 (시각순)</param>
public record ResultScheduleView(
    string Id, string AgentId, string? MachineName, string Title, string SourceKey, string? UserId, DateTime At,
    IReadOnlyList<string> Videos, bool Analysis, bool Search, string State, string? Error, DateTime Created,
    DateTime? StartedAt, IReadOnlyList<string>? StartedVideos);

/// <param name="Source">결과 확인을 다시 여는 경로 정보 (웹의 Source). 시작할 때 영상 목록을 모은 것으로 바꿔 작업에 적는다</param>
/// <param name="Starts">Videos마다 테스트 시작 초 (그 앞은 재지 않음). 예약 뒤 새로 생긴 영상은 0</param>
/// <param name="Analysis">영상 분석 요청 (Paths·Starts는 시작할 때 채움). null이면 영상 분석 안 함</param>
/// <param name="AnalysisParams">다시 열 때 되살릴 영상 분석 설정 (starts는 시작할 때 바꿈)</param>
/// <param name="Search">이미지 찾기 요청 (Paths는 시작할 때 채움, 영상 전체). null이면 이미지 찾기 안 함</param>
public record CreateResultScheduleRequest(
    string AgentId, string? MachineName, string Title, string SourceKey, JsonElement Source, DateTime At,
    IReadOnlyList<string> Videos, IReadOnlyList<double>? Starts,
    VideoAnalysisRequest? Analysis, JsonElement? AnalysisParams,
    ImageSearchRequest? Search, JsonElement? SearchParams);
