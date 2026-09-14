using System.Text.Json.Serialization;

namespace PcManager.Server.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter<UpdatePhase>))]
public enum UpdatePhase
{
    Idle,
    Downloading,
    Installing,
    /// <summary>서버 재시작 대기 (자가 업데이트)</summary>
    Restarting,
    Failed,
}

/// <summary>업데이트 확인 결과와 진행 상태</summary>
public record UpdateStatusView(
    string CurrentVersion,
    string? LatestVersion,
    bool UpdateAvailable,
    string? ReleaseName,
    string? ReleaseNotes,
    string? ReleaseUrl,
    DateTime? PublishedAt,
    DateTime? CheckedAt,
    string? CheckError,
    bool ServerAssetAvailable,
    UpdatePhase ServerPhase,
    string? ServerError);

public record AgentUpdateResultView(int Requested, int Dispatched, string? Error);
