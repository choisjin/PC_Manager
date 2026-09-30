namespace PcManager.Server.Contracts;

/// <summary>사용자가 수동으로 지정하는 PC 상태</summary>
public static class PcStatusValues
{
    public const string Available = "available";
    /// <summary>테스트 진행 중: 원격 접속 시 확인 후 허용</summary>
    public const string Testing = "testing";
    /// <summary>사용 금지: 원격 접속 차단</summary>
    public const string Forbidden = "forbidden";
    public const string Maintenance = "maintenance";

    public static readonly IReadOnlySet<string> All = new HashSet<string> { Available, Testing, Forbidden, Maintenance };
}

/// <param name="Status">PcStatusValues 중 하나</param>
/// <param name="Note">메모 (예: 누가 무슨 테스트 중)</param>
public record PcStatusView(string AgentId, string Status, string? Note, string? SetByUserId, DateTime SetAt);

/// <param name="Statuses">agentId → 상태. 없는 PC는 available</param>
public record PcStatusesView(IReadOnlyDictionary<string, PcStatusView> Statuses);

public record SetPcStatusRequest(string Status, string? Note);

/// <param name="InUseBy">agentId → 원격조작 중인 userId (실시간)</param>
public record RemoteUsageView(IReadOnlyDictionary<string, RemoteUserView> InUseBy);

public record RemoteUserView(string UserId, DateTime Since);

/// <param name="Mentions">@로 호출한 userId 목록 (없으면 빈 목록)</param>
public record ChatMessageView(long Id, string UserId, string Text, DateTime At, IReadOnlyList<string>? Mentions = null);

/// <param name="Jpeg">base64 JPEG (약 320px 폭)</param>
/// <param name="IdleSeconds">시계를 뺀 화면이 바뀌지 않은 시간(초)</param>
public record ThumbnailView(string AgentId, string Jpeg, int IdleSeconds, DateTime At);
