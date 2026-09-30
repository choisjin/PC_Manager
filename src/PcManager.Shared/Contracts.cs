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

    /// <summary>서버 HTTPS 공개 인증서 파일 (설치 스크립트가 내보냄, /api/install/ 아래로 배포)</summary>
    public const string ServerCertificateFile = "PcManager-Server.cer";

    /// <summary>대시보드 PC용 인증서 신뢰 설치 도구 (더블클릭, UAC 승인 한 번)</summary>
    public const string CertificateInstallerFile = "PcManager-인증서-설치.cmd";
}

/// <summary>파일 전송용 HTTP 경로 (에이전트 토큰 필요)</summary>
public static class AgentTransferPaths
{
    /// <summary>POST: 에이전트 → 서버 파일 업로드. 쿼리 path=상대 경로</summary>
    public static string UploadFile(string transferId) => $"/api/agent/transfers/{transferId}/files";

    /// <summary>GET: 서버 → 에이전트로 보낼 파일 내용</summary>
    public static string Content(string transferId) => $"/api/agent/transfers/{transferId}/content";
}

/// <summary>원격조작 WebSocket 경로</summary>
public static class AgentRemotePaths
{
    /// <summary>에이전트의 원격조작 프로세스가 접속한다 (에이전트 토큰 필요)</summary>
    public static string Session(string sessionId) => $"/api/agent/remote/{sessionId}";
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
    /// <summary>PC 안에서 선택 항목을 ZIP으로 압축 (PC에서 직접 수행)</summary>
    Compress,
}

/// <param name="SourceDirectory">null이면 ResultKey의 결과 폴더</param>
/// <param name="Patterns">glob 패턴 (예: **/*.xml)</param>
/// <param name="ResultKey">결과 폴더 이름 (JobRunId 또는 RunId)</param>
public record CollectFilesRequest(string TransferId, string? SourceDirectory, IReadOnlyList<string> Patterns, string ResultKey);

public record UploadFileRequest(string TransferId, string SourcePath);

public record DownloadFileRequest(string TransferId, string DestinationPath);

/// <param name="Paths">압축할 파일·폴더의 전체 경로 목록</param>
/// <param name="DestinationFolder">.zip을 만들 폴더 (보통 원본과 같은 폴더)</param>
/// <param name="ArchiveName">만들 zip 파일 이름 (충돌 시 자동 번호)</param>
/// <param name="SplitBytes">0보다 크면 이 크기로 나눠 .zip.001, .zip.002… 볼륨으로 만든다</param>
public record CompressRequest(string TransferId, IReadOnlyList<string> Paths, string DestinationFolder, string ArchiveName, long SplitBytes = 0);

public record TransferCompleted(string TransferId, bool Success, int FileCount, long TotalBytes, string? Error, DateTime FinishedAt);

/// <summary>오래 걸리는 전송(압축 등)의 진행 상황 보고</summary>
public record TransferProgressReport(string TransferId, int FileCount, long BytesDone, int Percent);

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
    Task Compress(CompressRequest request);

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

    /// <summary>FileOpRequest → FileOpResult. 같은 PC 안의 파일 조작(복사/이동/삭제/폴더 생성/이름 변경)</summary>
    public const string FileOp = "FileOp";

    /// <summary>(string destFolder, string fileName) → string writeId. PC 간 직접 전송의 받는 쪽 쓰기 세션 시작</summary>
    public const string BeginWrite = "BeginWrite";

    /// <summary>(string writeId, byte[] data) → int. 이어받은 조각을 순서대로 기록</summary>
    public const string WriteChunk = "WriteChunk";

    /// <summary>string writeId → string finalPath. 임시 파일을 최종 경로로 확정</summary>
    public const string CommitWrite = "CommitWrite";

    /// <summary>string writeId → bool. 쓰기 세션 취소(임시 파일 삭제)</summary>
    public const string AbortWrite = "AbortWrite";

    /// <summary>string sessionId → string? 오류. 사용자 세션에 원격조작 프로세스를 띄워 AgentRemotePaths.Session으로 접속시킨다</summary>
    public const string StartRemote = "StartRemote";

    /// <summary>string sessionId → string? 오류. 썸네일 모드 프로세스를 띄운다 (Remote 화면의 PC 미리보기)</summary>
    public const string StartThumbnail = "StartThumbnail";

    /// <summary>() → string? 오류. Ctrl+Alt+Del(SAS)을 보낸다 (서비스만 가능)</summary>
    public const string SendSecureAttention = "SendSecureAttention";
}

[JsonConverter(typeof(JsonStringEnumConverter<FileOpKind>))]
public enum FileOpKind
{
    /// <summary>Path를 Target 폴더로 복사 (이름 충돌 시 자동 번호)</summary>
    Copy,
    /// <summary>Path를 Target 폴더로 이동</summary>
    Move,
    /// <summary>Path 삭제 (폴더는 하위 포함)</summary>
    Delete,
    /// <summary>Path 폴더 안에 Target 이름의 새 폴더 생성</summary>
    CreateDirectory,
    /// <summary>Path의 이름을 Target으로 변경</summary>
    Rename,
}

public record FileOpRequest(FileOpKind Op, string Path, string? Target);

public record FileOpResult(bool Success, string? Error, string? ResultPath);

/// <summary>에이전트 → 서버 Hub 메서드 이름</summary>
public static class AgentHubMethods
{
    public const string Register = "Register";
    public const string ReportStarted = "ReportStarted";
    public const string ReportOutput = "ReportOutput";
    public const string ReportCompleted = "ReportCompleted";
    public const string ReportTransferCompleted = "ReportTransferCompleted";
    public const string ReportTransferProgress = "ReportTransferProgress";
}
