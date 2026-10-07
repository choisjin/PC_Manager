namespace PcManager.Server.Contracts;

/// <summary>잠긴 PC</summary>
/// <param name="OwnerUserId">잠근 사람</param>
/// <param name="Unlocked">이 브라우저가 PIN을 넣어 풀었는지</param>
public record PcLockView(string AgentId, string? OwnerUserId, DateTime LockedAt, bool Unlocked);

/// <summary>잠긴 PC에 접근했을 때 (423)</summary>
public record PcLockedView(string Error, string AgentId);

public record PinRequest(string? Pin);

public record ChangePinRequest(string? Pin, string? NewPin);
