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

    /// <summary>Windows 에이전트가 영상 자르기에 쓰는 ffmpeg (PATH에 없을 때 서버에서 받아 둔다)</summary>
    public const string FfmpegWindows = "/api/install/tools/ffmpeg.exe";
}

/// <summary>파일 전송용 HTTP 경로 (에이전트 토큰 필요)</summary>
public static class AgentTransferPaths
{
    /// <summary>POST: 에이전트 → 서버 파일 업로드. 쿼리 path=상대 경로</summary>
    public static string UploadFile(string transferId) => $"/api/agent/transfers/{transferId}/files";

    /// <summary>GET: 서버 → 에이전트로 보낼 파일 내용</summary>
    public static string Content(string transferId) => $"/api/agent/transfers/{transferId}/content";

    /// <summary>POST: 내 PC 프로그램으로 편집한 파일을 원래 PC로 저장. 쿼리 source, path, baseHash, backup(1이면 .bak) / 본문 = 파일 내용</summary>
    public const string EditSave = "/api/agent/edit/save";
}

/// <summary>
/// 원격 PC 파일을 대시보드를 연 PC(편집 PC)의 프로그램으로 열기: 서버가 파일을 편집 PC 에이전트로 보내고(PrepareEdit·WriteChunk),
/// OpenEdit로 확정하면 에이전트가 사용자 권한으로 기본 프로그램을 실행하고 저장을 감시해 EditSave로 되돌려 보낸다.
/// </summary>
/// <param name="BaseHash">보낸 내용의 SHA-256. 저장할 때 원래 파일이 그 사이 바뀌었는지 비교한다</param>
/// <param name="ReadOnly">압축 안 파일 등 되돌려 저장할 수 없는 파일 (열기만)</param>
/// <param name="Backup">저장할 때 원래 PC의 원본을 "파일.bak"으로 남긴다 (선택)</param>
public record OpenEditRequest(string WriteId, string SourceAgentId, string SourcePath, string BaseHash, bool ReadOnly, bool Backup = false);

/// <param name="Conflict">편집하는 동안 원래 파일이 바뀌어 옆에 새 이름으로 저장했다 (SavedPath)</param>
public record EditSaveResult(bool Success, string? Error, string? Hash, string? SavedPath, bool Conflict);

/// <summary>편집 PC의 편집 폴더(문서\PC Manager 편집) 현황</summary>
/// <param name="Path">편집 폴더. 로그인한 사용자가 없으면 null</param>
/// <param name="Files">남아 있는 받은 사본 수</param>
/// <param name="Pending">아직 원래 PC로 못 보낸 변경이 있는 사본 수</param>
public record EditFolderInfo(string? Path, int Files, long Bytes, int Pending);

/// <param name="InUse">프로그램이 열고 있어 남긴 사본 수</param>
/// <param name="Pending">원래 PC로 못 보낸 변경이 있어 남긴 사본 수</param>
public record EditCleanResult(int Deleted, long Bytes, int InUse, int Pending, EditFolderInfo Info);

/// <param name="OutputPath">자른 영상 경로 (원래 영상과 같은 폴더). 실패면 null</param>
public record VideoTrimResult(string? OutputPath, string? Error);

/// <summary>
/// 결과 확인 도구의 영상 재생 준비. PlayPath: 브라우저가 재생·탐색할 파일 (원본이 그대로 되면 원본, 아니면 변환한 캐시 파일, 아직 변환 전이면 null).
/// NeedsConvert: 길이·탐색 색인이 없거나(브라우저 녹화 webm 등) 브라우저가 못 푸는 코덱이라 변환이 필요함.
/// Duration·Fps: ffmpeg가 읽은 값 (모르면 null)
/// </summary>
public record VideoPrepareResult(string? PlayPath, bool NeedsConvert, double? Duration, double? Fps, string? Note, string? Error);

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
    /// <summary>파일 탐색기: 압축 풀기 (PC 안에서)</summary>
    Extract,
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

/// <param name="EntryPaths">풀 항목의 전체 경로("a.zip\폴더\파일"). 비면 전부</param>
public record ExtractRequest(string TransferId, string ArchivePath, IReadOnlyList<string> EntryPaths, string DestinationFolder);

/// <summary>편집한 파일 저장: BeginWrite/WriteChunk로 받은 임시 파일로 대상 파일을 바꾼다 (Backup이면 대상.bak을 남김)</summary>
public record CommitReplaceRequest(string WriteId, string TargetPath, bool Backup);

public record TransferCompleted(string TransferId, bool Success, int FileCount, long TotalBytes, string? Error, DateTime FinishedAt);

/// <summary>오래 걸리는 전송(압축 등)의 진행 상황 보고</summary>
public record TransferProgressReport(string TransferId, int FileCount, long BytesDone, int Percent);

/// <param name="Hidden">숨김 속성 (대시보드 '숨김 항목 보기'를 끄면 감춘다)</param>
public record FileEntry(string Name, string FullPath, bool IsDirectory, long Size, DateTime? ModifiedAt, bool Hidden = false);

/// <param name="Path">빈 문자열이면 드라이브 목록</param>
/// <param name="ArchivePath">압축 파일 안을 보고 있으면 그 압축 파일 경로 (읽기 전용)</param>
public record DirectoryListing(string Path, string? ParentPath, IReadOnlyList<FileEntry> Entries, string? Error, string? ArchivePath = null);

/// <summary>서버 → 에이전트 호출 (응답 없음)</summary>
public interface IAgentClient
{
    Task RunCommand(RunCommandRequest request);
    Task CancelCommand(string runId);
    Task CollectFiles(CollectFilesRequest request);
    Task UploadFile(UploadFileRequest request);
    Task DownloadFile(DownloadFileRequest request);
    Task Compress(CompressRequest request);

    Task Extract(ExtractRequest request);

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

    /// <summary>CommitReplaceRequest → string? 오류. 임시 파일로 기존 파일을 덮어쓴다 (텍스트 편집 저장)</summary>
    public const string CommitReplace = "CommitReplace";

    /// <summary>(string archivePath, string password) → bool. 암호 걸린 압축 파일의 암호를 기억시킨다</summary>
    public const string SetArchivePassword = "SetArchivePassword";

    /// <summary>(string folderLabel, string fileName) → string writeId. 편집 PC: 편집 폴더에 받을 준비 (이후 WriteChunk)</summary>
    public const string PrepareEdit = "PrepareEdit";

    /// <summary>OpenEditRequest → string? 오류. 편집 PC: 받은 파일을 확정하고 기본 프로그램으로 열어 저장을 감시</summary>
    public const string OpenEdit = "OpenEdit";

    /// <summary>string path → string? 오류. 이 PC의 파일을 그 자리에서 기본 프로그램으로 연다 (대시보드를 연 PC 자신의 파일)</summary>
    public const string LaunchFile = "LaunchFile";

    /// <summary>() → EditFolderInfo. 편집 폴더 현황</summary>
    public const string GetEditFolderInfo = "GetEditFolderInfo";

    /// <summary>() → string? 오류. 편집 폴더를 사용자 화면에 탐색기로 연다</summary>
    public const string OpenEditFolder = "OpenEditFolder";

    /// <summary>() → EditCleanResult. 다 보냈고 열려 있지 않은 받은 사본을 지운다</summary>
    public const string CleanEditFolder = "CleanEditFolder";

    /// <summary>(string extension, int size) → byte[]? PNG. 그 PC 윈도우의 확장자별 셸 아이콘 (탐색기와 같은 아이콘)</summary>
    public const string GetFileIcon = "GetFileIcon";

    /// <summary>string sessionId → string? 오류. 사용자 세션에 원격조작 프로세스를 띄워 AgentRemotePaths.Session으로 접속시킨다</summary>
    public const string StartRemote = "StartRemote";

    /// <summary>string sessionId → string? 오류. 썸네일 모드 프로세스를 띄운다 (Remote 화면의 PC 미리보기)</summary>
    public const string StartThumbnail = "StartThumbnail";

    /// <summary>() → string? 오류. Ctrl+Alt+Del(SAS)을 보낸다 (서비스만 가능)</summary>
    public const string SendSecureAttention = "SendSecureAttention";

    /// <summary>() → string? 오류. Linux: 로그인 관리자(GDM)의 Wayland를 끄고(Xorg 사용) 재부팅한다 (원격조작은 X11에서만 됨)</summary>
    public const string SwitchToX11 = "SwitchToX11";

    /// <summary>(string path, double startSec, double endSec) → VideoTrimResult. 영상 구간을 ffmpeg로 잘라 원래 영상 폴더에 저장 (결과 확인 도구)</summary>
    public const string TrimVideo = "TrimVideo";
    /// <summary>(string path, bool convert) → VideoPrepareResult. 영상 길이·fps를 읽고, convert면 탐색 가능한 재생용 사본을 만든다 (캐시)</summary>
    public const string PrepareVideo = "PrepareVideo";
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
