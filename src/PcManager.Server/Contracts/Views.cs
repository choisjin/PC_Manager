using PcManager.Server.Data;
using PcManager.Shared;

namespace PcManager.Server.Contracts;

public record AgentView(
    string Id,
    string MachineName,
    string OsVersion,
    string AgentVersion,
    string UserName,
    IReadOnlyList<string> IpAddresses,
    IReadOnlyList<string> MacAddresses,
    IReadOnlyList<string> Tags,
    bool Online,
    DateTime FirstSeenAt,
    DateTime LastSeenAt);

public record RunView(
    string Id,
    string AgentId,
    string? JobRunId,
    int? StepIndex,
    ShellKind Shell,
    string CommandLine,
    string? WorkingDirectory,
    int TimeoutSeconds,
    RunState State,
    int? ExitCode,
    string? Error,
    DateTime CreatedAt,
    DateTime? StartedAt,
    DateTime? FinishedAt);

public record CreateRunsRequest(
    IReadOnlyList<string>? AgentIds,
    ShellKind Shell,
    string? CommandLine,
    string? WorkingDirectory,
    int TimeoutSeconds,
    string? Encoding);

public static class ViewMappings
{
    public static AgentView ToView(this AgentEntity a, bool online) => new(
        a.Id, a.MachineName, a.OsVersion, a.AgentVersion, a.UserName,
        a.IpAddresses, a.MacAddresses, a.Tags, online, a.FirstSeenAt, a.LastSeenAt);

    public static RunView ToView(this RunEntity r) => new(
        r.Id, r.AgentId, r.JobRunId, r.StepIndex, r.Shell, r.CommandLine, r.WorkingDirectory, r.TimeoutSeconds,
        r.State, r.ExitCode, r.Error, r.CreatedAt, r.StartedAt, r.FinishedAt);
}
