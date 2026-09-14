using System.Text.Json.Serialization;

namespace PcManager.Shared;

/// <summary>SignalR Hub 경로</summary>
public static class HubPaths
{
    public const string Agent = "/hubs/agent";
    public const string Dashboard = "/hubs/dashboard";
}

public static class AgentHeaders
{
    /// <summary>에이전트 등록 토큰 헤더</summary>
    public const string Token = "X-Agent-Token";
}

[JsonConverter(typeof(JsonStringEnumConverter<ShellKind>))]
public enum ShellKind
{
    Cmd,
    PowerShell,
}

[JsonConverter(typeof(JsonStringEnumConverter<RunState>))]
public enum RunState
{
    Pending,
    Running,
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
}

[JsonConverter(typeof(JsonStringEnumConverter<OutputStream>))]
public enum OutputStream
{
    StdOut,
    StdErr,
    /// <summary>에이전트가 덧붙이는 안내 메시지 (타임아웃, 취소 등)</summary>
    System,
}

public record AgentInfo(
    string AgentId,
    string MachineName,
    string OsVersion,
    string AgentVersion,
    string UserName,
    IReadOnlyList<string> IpAddresses,
    IReadOnlyList<string> MacAddresses,
    IReadOnlyList<string> Tags);

/// <param name="TimeoutSeconds">0이면 제한 없음</param>
/// <param name="Encoding">출력 인코딩 이름. null이면 시스템 OEM 코드 페이지</param>
/// <param name="JobRunId">Job 단계로 실행될 때 Job 실행 ID. 같은 Job의 단계들이 결과 폴더를 공유한다</param>
public record RunCommandRequest(
    string RunId,
    ShellKind Shell,
    string CommandLine,
    string? WorkingDirectory,
    int TimeoutSeconds,
    string? Encoding,
    string? JobRunId);

public record CommandStarted(string RunId, int ProcessId, DateTime StartedAt);

/// <param name="Seq">명령별 1부터 증가하는 줄 번호 (재전송 중복 제거용)</param>
public record CommandOutput(string RunId, long Seq, OutputStream Stream, string Text, DateTime Timestamp);

public record CommandCompleted(string RunId, RunState State, int? ExitCode, string? Error, DateTime FinishedAt);

/// <summary>에이전트가 명령 프로세스에 넘기는 환경 변수</summary>
public static class AgentEnvironment
{
    public const string RunId = "PCM_RUN_ID";
    public const string JobRunId = "PCM_JOB_RUN_ID";

    /// <summary>테스트가 결과 파일을 저장할 폴더. 결과 수집 단계의 기본 대상</summary>
    public const string ResultDir = "PCM_RESULT_DIR";
}

/// <summary>에이전트 설치 파일 관련 경로</summary>
public static class InstallPaths
{
    public const string AgentSetupFile = "PcManager-Agent-Setup.exe";

    /// <summary>서버가 제공하는 에이전트 설치 파일 다운로드 경로</summary>
    public static string AgentSetup => "/api/install/" + AgentSetupFile;
}

/// <summary>파일 전송용 HTTP 경로 (에이전트 토큰 필요)</summary>
public static class AgentTransferPaths
{
    /// <summary>POST: 에이전트 → 서버 파일 업로드. 쿼리 path=상대 경로</summary>
    public static string UploadFile(string transferId) => $"/api/agent/transfers/{transferId}/files";

    /// <summary>GET: 서버 → 에이전트로 보낼 파일 내용</summary>
    public static string Content(string transferId) => $"/api/agent/transfers/{transferId}/content";
}

[JsonConverter(typeof(JsonStringEnumConverter<TransferKind>))]
public enum TransferKind
{
    /// <summary>결과 폴더 수집 (Job 단계)</summary>
    Collect,
    /// <summary>파일 탐색기에서 PC의 파일을 서버로 가져오기</summary>
    Fetch,
    /// <summary>파일 탐색기에서 서버의 파일을 PC로 올리기</summary>
    Push,
}

/// <param name="SourceDirectory">null이면 ResultKey의 결과 폴더</param>
/// <param name="Patterns">glob 패턴 (예: **/*.xml)</param>
/// <param name="ResultKey">결과 폴더 이름 (JobRunId 또는 RunId)</param>
public record CollectFilesRequest(string TransferId, string? SourceDirectory, IReadOnlyList<string> Patterns, string ResultKey);

public record UploadFileRequest(string TransferId, string SourcePath);

public record DownloadFileRequest(string TransferId, string DestinationPath);

public record TransferCompleted(string TransferId, bool Success, int FileCount, long TotalBytes, string? Error, DateTime FinishedAt);

public record FileEntry(string Name, string FullPath, bool IsDirectory, long Size, DateTime? ModifiedAt);

/// <param name="Path">빈 문자열이면 드라이브 목록</param>
public record DirectoryListing(string Path, string? ParentPath, IReadOnlyList<FileEntry> Entries, string? Error);

/// <summary>서버 → 에이전트 호출 (응답 없음)</summary>
public interface IAgentClient
{
    Task RunCommand(RunCommandRequest request);
    Task CancelCommand(string runId);
    Task CollectFiles(CollectFilesRequest request);
    Task UploadFile(UploadFileRequest request);
    Task DownloadFile(DownloadFileRequest request);

    /// <param name="setupUrl">설치 파일 URL. null이면 에이전트가 자신의 서버 주소에서 받는다</param>
    Task UpdateAgent(string? setupUrl);
}

/// <summary>서버 → 에이전트 호출 중 응답을 기다리는 메서드 (SignalR client result)</summary>
public static class AgentClientMethods
{
    /// <summary>string path → DirectoryListing</summary>
    public const string ListDirectory = "ListDirectory";

    /// <summary>string path → long (파일 크기, 없거나 접근 불가면 -1). 영상 스트리밍용</summary>
    public const string GetFileSize = "GetFileSize";

    /// <summary>(string path, long offset, int length) → byte[] (EOF면 더 짧을 수 있음). 영상 스트리밍용</summary>
    public const string ReadFileChunk = "ReadFileChunk";
}

/// <summary>에이전트 → 서버 Hub 메서드 이름</summary>
public static class AgentHubMethods
{
    public const string Register = "Register";
    public const string ReportStarted = "ReportStarted";
    public const string ReportOutput = "ReportOutput";
    public const string ReportCompleted = "ReportCompleted";
    public const string ReportTransferCompleted = "ReportTransferCompleted";
}
