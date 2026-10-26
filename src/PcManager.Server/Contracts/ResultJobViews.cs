using System.Text.Json;

namespace PcManager.Server.Contracts;

/// <summary>결과 확인의 오래 걸리는 작업 종류 (테스트 PC 에이전트가 돌린다)</summary>
public static class ResultJobKinds
{
    /// <summary>영상 분석 (검은 화면·깜박임·정지 구간)</summary>
    public const string Analysis = "analysis";
    /// <summary>이미지 찾기</summary>
    public const string Search = "search";

    public static readonly IReadOnlySet<string> All = new HashSet<string> { Analysis, Search };
}

/// <summary>
/// 결과 확인 작업 하나: 결과 확인 탭을 닫거나 새로 고쳐도 에이전트에서 계속 돌고, 서버가 진행을 물어 대시보드에 알린다.
/// </summary>
/// <param name="Id">에이전트 작업 id</param>
/// <param name="Title">결과 이름 (셋 이름 또는 Result 파일 이름)</param>
/// <param name="SourceKey">어느 결과의 작업인지 (웹이 정한 열쇠: PC·Result·영상 경로). 결과 확인을 다시 열면 이걸로 찾아 이어 받는다</param>
/// <param name="Open">이 결과를 새 탭에서 다시 여는 요청 (웹의 ResultTabRequest)</param>
/// <param name="State">running · done · canceled · failed · lost(에이전트에서 작업이 사라짐)</param>
/// <param name="Seen">끝난 뒤 결과를 열어 봤는지 (안 봤으면 PC 목록에 '분석 완료')</param>
public record ResultJobView(
    string Id, string Kind, string AgentId, string? MachineName, string Title, string SourceKey, string? UserId, JsonElement? Open,
    string State, double Progress, string? Current, string? Error, DateTime Started, DateTime? Finished, bool Seen);

/// <param name="Params">다시 열 때 되살릴 웹 설정 (화면 영역·정지 기준·크롭 이미지 등)</param>
public record RegisterResultJobRequest(
    string Id, string Kind, string AgentId, string? MachineName, string Title, string SourceKey, JsonElement? Open, JsonElement? Params);
