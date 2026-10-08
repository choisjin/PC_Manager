namespace PcManager.Server.Contracts;

/// <summary>State 화면 노드 위치 (화면 영역 비율 0~1)</summary>
public record StatePoint(double X, double Y);

/// <param name="Positions">"server" · "g:그룹 id" · "u:사용자 id" → 위치</param>
/// <param name="Locked">고정: 끌어서 옮기지 못한다</param>
/// <param name="UpdatedBy">마지막으로 바꾼 사용자 id</param>
public record StateLayoutView(IReadOnlyDictionary<string, StatePoint> Positions, bool Locked, string? UpdatedBy, DateTime? UpdatedAt);
