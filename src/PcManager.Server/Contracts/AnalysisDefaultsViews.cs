namespace PcManager.Server.Contracts;

/// <summary>
/// 영상 분석 기준값 (프로젝트별): 검출 판정의 기본값을 장치 사양에 맞게 바꾼다 (깜박임 최대 길이·급격히 꺼지는 시간·지연 기준 등).
/// 이름 → 값만 저장하고 뜻·범위는 대시보드가 안다 (없는 이름은 대시보드 기본값, 모르는 이름은 무시)
/// </summary>
/// <param name="Values">기준값 이름 → 값</param>
/// <param name="UpdatedBy">마지막으로 바꾼 사용자 id</param>
/// <param name="UpdatedAt">마지막으로 바꾼 시각 (UTC)</param>
public record AnalysisDefaultsView(IReadOnlyDictionary<string, double> Values, string? UpdatedBy, DateTime? UpdatedAt);

/// <summary>기준값 저장 요청: 바꾼 값만 (비우면 모두 대시보드 기본값으로)</summary>
public record SaveAnalysisDefaults(IReadOnlyDictionary<string, double>? Values);
