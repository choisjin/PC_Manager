using System.Text.Json.Serialization;

namespace PcManager.Agent;

/// <summary>런처 ↔ 에이전트 서비스 로컬 통신 규약 (named pipe, 요청 1줄 → 응답 1줄 JSON)</summary>
public static class LocalControl
{
    public const string PipeName = "PcManager.Agent.Control";

    public const string StatusCommand = "status";
    public const string ConnectCommand = "connect";
    public const string DisconnectCommand = "disconnect";
    public const string UpdateCommand = "update";
}

[JsonConverter(typeof(JsonStringEnumConverter<ConnectionStatus>))]
public enum ConnectionStatus
{
    /// <summary>서버 주소가 없음</summary>
    NotConfigured,
    /// <summary>사용자가 연결을 끊음</summary>
    Disconnected,
    Connecting,
    Connected,
}

public record LocalStatus(
    ConnectionStatus Status,
    string ServerUrl,
    string MachineName,
    string AgentVersion,
    string? ServerVersion,
    bool UpdateAvailable,
    bool Updating,
    string? LastError);

/// <param name="Command">LocalControl의 *Command 상수</param>
/// <param name="ServerUrl">connect 명령에서 사용</param>
public record LocalRequest(string Command, string? ServerUrl = null);

public record LocalResponse(bool Ok, string? Error, LocalStatus? Status);
