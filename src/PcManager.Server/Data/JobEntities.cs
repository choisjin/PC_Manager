using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json;
using System.Text.Json.Serialization;
using PcManager.Shared;

namespace PcManager.Server.Data;

[JsonConverter(typeof(JsonStringEnumConverter<JobState>))]
public enum JobState
{
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

[JsonConverter(typeof(JsonStringEnumConverter<JobStepKind>))]
public enum JobStepKind
{
    /// <summary>명령 실행</summary>
    Command,
    /// <summary>결과 파일 수집</summary>
    Collect,
}

[JsonConverter(typeof(JsonStringEnumConverter<TransferState>))]
public enum TransferState
{
    Pending,
    Succeeded,
    Failed,
}

public class JobStepDefinition
{
    public JobStepKind Kind { get; set; }
    public string? Name { get; set; }

    // Command
    public ShellKind Shell { get; set; }
    public string? CommandLine { get; set; }
    public string? WorkingDirectory { get; set; }
    public int TimeoutSeconds { get; set; } = 600;
    public string? Encoding { get; set; }

    // Collect: SourceDirectory가 비어 있으면 PCM_RESULT_DIR
    public string? SourceDirectory { get; set; }
    public List<string> Patterns { get; set; } = [];

    /// <summary>이 단계가 실패해도 다음 단계를 계속 실행</summary>
    public bool ContinueOnError { get; set; }
}

/// <summary>Job 실행 1회. PC별 진행 상황은 JobTargetEntity</summary>
public class JobRunEntity
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public required string Id { get; set; }
    public string Name { get; set; } = "";
    public string StepsJson { get; set; } = "[]";
    public int MaxParallel { get; set; }
    public JobState State { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? FinishedAt { get; set; }

    [NotMapped]
    public List<JobStepDefinition> Steps
    {
        get => JsonSerializer.Deserialize<List<JobStepDefinition>>(StepsJson, Json) ?? [];
        set => StepsJson = JsonSerializer.Serialize(value, Json);
    }
}

public class JobTargetEntity
{
    public required string JobRunId { get; set; }
    public required string AgentId { get; set; }
    public JobState State { get; set; }

    /// <summary>실행 중이거나 마지막으로 실행한 단계 (시작 전 -1)</summary>
    public int CurrentStep { get; set; } = -1;

    public string? Error { get; set; }

    // 수집된 JUnit XML 합계
    public int? TestsTotal { get; set; }
    public int? TestsFailed { get; set; }
    public int? TestsSkipped { get; set; }

    public DateTime? StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
}

public class TransferEntity
{
    public required string Id { get; set; }
    public required string AgentId { get; set; }
    public TransferKind Kind { get; set; }
    public string? JobRunId { get; set; }
    public int? StepIndex { get; set; }

    /// <summary>Collect: 수집 폴더(null이면 결과 폴더), Fetch: PC의 파일 경로, Push: PC에 저장할 경로</summary>
    public string? Path { get; set; }

    public List<string> Patterns { get; set; } = [];
    public TransferState State { get; set; }
    public int FileCount { get; set; }
    public long TotalBytes { get; set; }
    public string? Error { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
}

/// <summary>서버에 저장된 결과 파일</summary>
public class ArtifactEntity
{
    public required string Id { get; set; }
    public required string TransferId { get; set; }
    public required string AgentId { get; set; }
    public string? JobRunId { get; set; }
    public required string RelativePath { get; set; }
    public long Size { get; set; }
    public DateTime CreatedAt { get; set; }

    // JUnit XML이면 집계 (아니면 null)
    public int? TestsTotal { get; set; }
    public int? TestsFailed { get; set; }
    public int? TestsSkipped { get; set; }
}
