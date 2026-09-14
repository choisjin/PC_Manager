using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using PcManager.Shared;

namespace PcManager.Server.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AgentEntity> Agents => Set<AgentEntity>();
    public DbSet<RunEntity> Runs => Set<RunEntity>();
    public DbSet<JobRunEntity> JobRuns => Set<JobRunEntity>();
    public DbSet<JobTargetEntity> JobTargets => Set<JobTargetEntity>();
    public DbSet<TransferEntity> Transfers => Set<TransferEntity>();
    public DbSet<ArtifactEntity> Artifacts => Set<ArtifactEntity>();

    protected override void ConfigureConventions(ModelConfigurationBuilder builder)
    {
        // SQLite에서 읽은 DateTime은 Kind가 Unspecified라서 UTC로 지정해야 JSON에 'Z'가 붙는다
        builder.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<RunEntity>(run =>
        {
            run.HasIndex(r => new { r.AgentId, r.CreatedAt });
            run.HasIndex(r => r.CreatedAt);
            run.Property(r => r.State).HasConversion<string>();
            run.Property(r => r.Shell).HasConversion<string>();
            run.HasIndex(r => r.JobRunId);
        });

        modelBuilder.Entity<JobRunEntity>(job =>
        {
            job.HasIndex(j => j.CreatedAt);
            job.Property(j => j.State).HasConversion<string>();
        });

        modelBuilder.Entity<JobTargetEntity>(target =>
        {
            target.HasKey(t => new { t.JobRunId, t.AgentId });
            target.Property(t => t.State).HasConversion<string>();
        });

        modelBuilder.Entity<TransferEntity>(transfer =>
        {
            transfer.HasIndex(t => new { t.AgentId, t.CreatedAt });
            transfer.HasIndex(t => t.JobRunId);
            transfer.Property(t => t.Kind).HasConversion<string>();
            transfer.Property(t => t.State).HasConversion<string>();
        });

        modelBuilder.Entity<ArtifactEntity>(artifact =>
        {
            // 에이전트 재전송 시 같은 파일은 덮어쓴다
            artifact.HasIndex(a => new { a.TransferId, a.RelativePath }).IsUnique();
            artifact.HasIndex(a => new { a.JobRunId, a.AgentId });
        });
    }

    private sealed class UtcDateTimeConverter() : ValueConverter<DateTime, DateTime>(
        v => v.ToUniversalTime(),
        v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
}

public class AgentEntity
{
    public required string Id { get; set; }
    public string MachineName { get; set; } = "";
    public string OsVersion { get; set; } = "";
    public string AgentVersion { get; set; } = "";
    public string UserName { get; set; } = "";
    public List<string> IpAddresses { get; set; } = [];
    public List<string> MacAddresses { get; set; } = [];
    public List<string> Tags { get; set; } = [];
    public DateTime FirstSeenAt { get; set; }
    public DateTime LastSeenAt { get; set; }
}

public class RunEntity
{
    public required string Id { get; set; }
    public required string AgentId { get; set; }

    /// <summary>Job 단계로 실행된 경우 Job 실행 ID</summary>
    public string? JobRunId { get; set; }
    public int? StepIndex { get; set; }

    public ShellKind Shell { get; set; }
    public string CommandLine { get; set; } = "";
    public string? WorkingDirectory { get; set; }
    public int TimeoutSeconds { get; set; }
    public string? Encoding { get; set; }
    public RunState State { get; set; }
    public int? ExitCode { get; set; }
    public string? Error { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
}
