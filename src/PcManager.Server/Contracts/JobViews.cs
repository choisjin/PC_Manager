using PcManager.Server.Data;
using PcManager.Shared;

namespace PcManager.Server.Contracts;

public record TransferView(
    string Id, string AgentId, TransferKind Kind, string? JobRunId, int? StepIndex, string? Path,
    TransferState State, int FileCount, long TotalBytes, string? Error, DateTime CreatedAt, DateTime? FinishedAt);

public record ArtifactView(
    string Id, string TransferId, string AgentId, string? JobRunId, string RelativePath, long Size, DateTime CreatedAt,
    int? TestsTotal, int? TestsFailed, int? TestsSkipped);

public record JobRunView(
    string Id, string Name, IReadOnlyList<JobStepDefinition> Steps, int MaxParallel,
    JobState State, DateTime CreatedAt, DateTime? FinishedAt);

public record JobTargetView(
    string JobRunId, string AgentId, JobState State, int CurrentStep, string? Error,
    int? TestsTotal, int? TestsFailed, int? TestsSkipped, DateTime? StartedAt, DateTime? FinishedAt);

public record JobRunDetailView(JobRunView Job, IReadOnlyList<JobTargetView> Targets);

/// <param name="AgentIds">직접 선택한 PC</param>
/// <param name="Tags">이 태그 중 하나라도 가진 PC를 대상에 추가</param>
/// <param name="MaxParallel">동시에 실행할 PC 수 (0이면 제한 없음)</param>
public record CreateJobRequest(
    string? Name, IReadOnlyList<string>? AgentIds, IReadOnlyList<string>? Tags,
    IReadOnlyList<JobStepDefinition>? Steps, int MaxParallel);

public record FetchFileRequest(string? Path);

public static class JobViewMappings
{
    public static TransferView ToView(this TransferEntity t) => new(
        t.Id, t.AgentId, t.Kind, t.JobRunId, t.StepIndex, t.Path,
        t.State, t.FileCount, t.TotalBytes, t.Error, t.CreatedAt, t.FinishedAt);

    public static ArtifactView ToView(this ArtifactEntity a) => new(
        a.Id, a.TransferId, a.AgentId, a.JobRunId, a.RelativePath, a.Size, a.CreatedAt,
        a.TestsTotal, a.TestsFailed, a.TestsSkipped);

    public static JobRunView ToView(this JobRunEntity j) => new(
        j.Id, j.Name, j.Steps, j.MaxParallel, j.State, j.CreatedAt, j.FinishedAt);

    public static JobTargetView ToView(this JobTargetEntity t) => new(
        t.JobRunId, t.AgentId, t.State, t.CurrentStep, t.Error,
        t.TestsTotal, t.TestsFailed, t.TestsSkipped, t.StartedAt, t.FinishedAt);
}
