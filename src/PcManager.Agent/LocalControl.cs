using System.Text.Json.Serialization;

namespace PcManager.Agent;

/// <summary>런처 ↔ 에이전트 서비스 로컬 통신 규약 (named pipe, 요청 1줄 → 응답 1줄 JSON)</summary>
public static class LocalControl
{
    public const string PipeName = "PcManager.Agent.Control";

    /// <summary>Linux: 같은 규약을 Unix 소켓으로 (서비스는 root, 런처는 로그인 사용자라 누구나 쓸 수 있게 연다)</summary>
    public const string UnixSocketPath = "/run/pcmanager-agent/control.sock";

    public const string StatusCommand = "status";
    public const string ConnectCommand = "connect";
    public const string DisconnectCommand = "disconnect";
    public const string UpdateCommand = "update";

    /// <summary>에이전트 서비스(프로세스)를 완전히 종료</summary>
    public const string StopCommand = "stop";

    /// <summary>물리 모니터가 켜져 있어 가상 모니터를 끈다 (런처가 사용자 세션에서 확장 화면 상태를 발견했을 때)</summary>
    public const string ReleaseVirtualDisplayCommand = "release-virtual-display";
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
    string? LastError,
    /// <summary>대시보드 HTTPS 주소 (서버가 HTTPS를 쓰면). null이면 ServerUrl로 연다</summary>
    string? DashboardUrl = null,
    /// <summary>업데이트 진행(다운로드 n% · 설치 중) 또는 마지막 업데이트 실패 이유</summary>
    string? UpdateNote = null);

/// <param name="Command">LocalControl의 *Command 상수</param>
/// <param name="ServerUrl">connect 명령에서 사용</param>
public record LocalRequest(string Command, string? ServerUrl = null);

public record LocalResponse(bool Ok, string? Error, LocalStatus? Status);
