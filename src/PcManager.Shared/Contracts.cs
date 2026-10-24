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

    /// <summary>POST: 에이전트 → 서버 영상 구간 스트림 (StreamFileRange). 본문을 받는 대로 브라우저로 넘긴다</summary>
    public static string MediaStream(string streamId) => $"/api/agent/media/{streamId}";
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
/// NeedsConvert: 길이·탐색 색인이 없거나(브라우저 녹화 webm 등) 브라우저가 못 푸는 코덱이라 변환이 필요함 (사용자가 승인하면 convert로 다시 부른다).
/// Duration·Fps: ffmpeg가 읽은 값 (모르면 null). Note: 변환이 무엇을 하는지 (색인을 넣은 사본 · H.264로 다시 인코딩)
/// </summary>
/// <param name="Reason">왜 바로 재생할 수 없는지 (변환 승인 안내)</param>
/// <param name="Transcode">다시 인코딩한다 (오래 걸림). false면 영상은 그대로 옮겨 담기만 (빠름, 화질 그대로)</param>
/// <param name="SourceBytes">원본 크기 (사본도 대략 이만큼)</param>
/// <param name="CacheDrive">사본을 둘 드라이브 · CacheFreeBytes: 그 드라이브의 남은 공간</param>
public record VideoPrepareResult(string? PlayPath, bool NeedsConvert, double? Duration, double? Fps, string? Note, string? Error,
    string? Reason = null, bool Transcode = false, long SourceBytes = 0, string? CacheDrive = null, long CacheFreeBytes = 0);

/// <summary>테스트 PC 드라이브 하나 (Linux는 마운트 지점)</summary>
public record DriveSpace(string Name, string? Label, long FreeBytes, long TotalBytes);

/// <param name="Name">재생용 사본 폴더 안 파일 이름 (지울 때 쓴다)</param>
/// <param name="Source">원본 영상 경로 (모르면 null: 이전 버전이 만든 사본)</param>
/// <param name="LastUsed">마지막으로 쓴 시각 (UTC)</param>
/// <param name="Converting">지금 만드는 중</param>
public record VideoCacheEntry(string Name, long Bytes, DateTime LastUsed, string? Source, bool Converting);

/// <summary>결과 확인 Result 탭의 저장 공간: 드라이브 남은 공간 + 재생용 사본 목록 (사용자가 직접 지운다)</summary>
public record VideoStorageInfo(IReadOnlyList<DriveSpace> Drives, string CacheDirectory, IReadOnlyList<VideoCacheEntry> Cache);

/// <param name="Failed">지우지 못한 사본 (만드는 중·사용 중)</param>
public record VideoCacheDeleteResult(int Deleted, long FreedBytes, IReadOnlyList<string> Failed);

/// <summary>
/// 재생 준비 진행 (결과 확인 화면이 속도·남은 시간을 계산해 보여 준다).
/// Stage: ffmpeg = 테스트 PC가 서버에서 ffmpeg를 받는 중 · convert = 재생용 사본 만드는 중.
/// Bytes/TotalBytes: 받은 바이트 (ffmpeg) 또는 처리한 원본 바이트 = 진행률 × 원본 크기 (convert)
/// </summary>
public record VideoPrepareProgress(string Stage, double Fraction, long Bytes, long TotalBytes, double ElapsedSeconds);

/// <summary>
/// 결과 확인 도구의 이미지 찾기: 영상들의 모든 프레임에서 검색 영역 안의 템플릿(크롭한 이미지) 유사도를 잰다.
/// 좌표는 FrameWidth×FrameHeight(크롭한 영상의 원래 크기) 기준 픽셀. 크기가 다른 영상은 그 크기로 늘려 비교.
/// Template: TemplateWidth×TemplateHeight 회색조(0~255) 픽셀, 한 줄씩
/// </summary>
/// <param name="Ranges">이 구간들만 훑는다 (고른 스텝 앞뒤 몇 초). null이면 영상 전체. 구간이 없는 영상은 훑지 않는다</param>
public record ImageSearchRequest(
    IReadOnlyList<string> Paths, int FrameWidth, int FrameHeight,
    int TemplateWidth, int TemplateHeight, byte[] Template,
    int SearchX, int SearchY, int SearchWidth, int SearchHeight,
    IReadOnlyList<ImageSearchRange>? Ranges = null);

/// <summary>이미지 찾기로 훑을 구간: Paths의 Video번째 영상 Start~End초</summary>
public record ImageSearchRange(int Video, double Start, double End);

/// <param name="Fps">Scores 한 칸의 간격 (프레임 i = i/Fps초)</param>
/// <param name="Scores">프레임별 유사도 0~200 (= 0~100%, 0.5% 단위)</param>
public record ImageSearchVideo(string Path, double Fps, byte[] Scores, string? Error);

/// <param name="State">running · done · failed · canceled</param>
/// <param name="Progress">0~1</param>
/// <param name="Videos">끝난 영상 (요청의 have개 다음부터)</param>
/// <param name="Scale">템플릿·검색 영역을 줄인 배율 (계산량 때문에, 1이면 원래 크기)</param>
public record ImageSearchStatus(string State, double Progress, string? Current, IReadOnlyList<ImageSearchVideo> Videos, int Scale, string? Error);

/// <summary>이미지 찾기 결과 조각: Video번째 영상의 Offset 프레임부터 유사도 (훑는 중인 영상은 확정된 프레임까지)</summary>
/// <param name="Done">이 영상의 마지막 조각 (다 훑었다)</param>
public record ImageSearchChunk(int Video, string Path, double Fps, int Offset, byte[] Scores, bool Done, string? Error);

/// <param name="Chunks">요청한 위치(video, offset)부터 이어지는 결과. 서버 SignalR 메시지 한도(2MB) 안에 들게 한 번에 1MB까지</param>
/// <param name="More">더 받을 결과가 남았다 (곧바로 다시 묻는다)</param>
public record ImageSearchProgress(string State, double Progress, string? Current, int Scale, string? Error,
    IReadOnlyList<ImageSearchChunk> Chunks, bool More);

/// <summary>
/// 결과 확인 도구의 영상 분석 (ReplayKit_FailAnalyzer 영상 페이지와 같은 방식): 영상들의 모든 프레임에서 화면 영역의
/// 밝기·프레임 차이·윤곽·평균 색(·베젤 테두리 밝기)을 잰다. 검은 화면·깜박임·정지·화면 전환 판정은 웹이 한다.
/// 영역은 영상 크기에 대한 비율: 직사각형 [x0, y0, x1, y1] 또는 꼭짓점 넷 [x, y]×4 (왼쪽 위 · 오른쪽 위 · 오른쪽 아래 · 왼쪽 아래,
/// 비스듬히 찍힌 화면 — 에이전트가 perspective로 반듯하게 펴서 잰다)
/// </summary>
/// <param name="Roi">화면 영역. null이면 에이전트가 추정한다 (칸별 윤곽 변화가 큰 곳, 못 찾으면 화면 전체)</param>
/// <param name="Bezel">베젤 외곽 (화면을 감싸는 모니터 테두리 바깥선). 주면 외곽에서 화면을 뺀 테두리 띠의 밝기도 잰다 (Roi가 있을 때만, 화면을 감싸야 함)</param>
/// <param name="Starts">영상마다 이 초부터만 잰다 (테스트 시작 전은 재지 않음, Paths와 같은 차례). 영상 길이 이상이면 그 영상은 재지 않는다. null·0이면 처음부터</param>
public record VideoAnalysisRequest(IReadOnlyList<string> Paths, double[]? Roi = null, double[]? Bezel = null, double[]? Starts = null);

/// <summary>
/// 영상 분석 결과 조각: Video번째 영상의 Offset번째 프레임부터. 프레임마다 31바이트 (little-endian):
/// double 시각(초) · float 밝기 · float 프레임 차이 · float 윤곽 · float 윤곽이 가장 많은 칸(8×4) ·
/// float 베젤 테두리 밝기 (베젤이 없으면 0) · 평균 색 R·G·B
/// </summary>
/// <param name="Marks">이 조각 안에서 측정 구간이 끝난 자리 (프레임 수). 웹은 이 경계마다 판정한다 (기준값 창이 ReplayKit_FailAnalyzer와 같게)</param>
/// <param name="Done">이 영상의 마지막 조각 (다 쟀다)</param>
public record VideoAnalysisChunk(int Video, string Path, int Offset, byte[] Frames, int[] Marks, bool Done, string? Error);

/// <param name="State">running · done · failed · canceled</param>
/// <param name="Progress">0~1 (잰 시간의 합 기준)</param>
/// <param name="Roi">쓴 화면 영역 (추정 전이면 null). 꼭짓점 넷으로 받았으면 꼭짓점 넷으로 돌려준다</param>
/// <param name="RoiSource">화면 영역을 정한 방법 ("직접 지정" · "자동 추정 (…)" · "화면 전체 (…)")</param>
/// <param name="Bezel">쓴 베젤 외곽 (화면을 감싸게 넓힌 것, 없거나 테두리 띠가 너무 얇으면 null)</param>
/// <param name="Chunks">요청한 위치(video, offset)부터 이어지는 결과. 서버 SignalR 메시지 한도(2MB) 안에 들게 한 번에 1MB까지</param>
/// <param name="More">더 받을 결과가 남았다 (곧바로 다시 묻는다)</param>
public record VideoAnalysisProgress(string State, double Progress, string? Current, string? Error,
    double[]? Roi, string? RoiSource, double[]? Bezel, IReadOnlyList<VideoAnalysisChunk> Chunks, bool More);

/// <summary>PC 정보 패널의 시스템·디스크 탭</summary>
/// <param name="Platform">windows · linux</param>
/// <param name="Os">"Windows 11 Pro" · "Ubuntu 24.04.1 LTS"</param>
/// <param name="OsVersion">Windows 버전 ("24H2"). Linux는 null</param>
/// <param name="OsBuild">Windows 빌드 ("26100.4061") · Linux 커널 ("6.8.0-45-generic")</param>
/// <param name="Bios">BIOS 버전과 날짜</param>
/// <param name="Cores">물리 코어 수 (모르면 0)</param>
/// <param name="MemoryBytes">설치된 메모리</param>
/// <param name="Users">로그인한 사용자 (화면·원격 데스크톱)</param>
public record PcSystemInfo(string Platform, string MachineName, string Os, string? OsVersion, string OsBuild, string Architecture,
    string? Manufacturer, string? Model, string? Bios, string Cpu, int Cores, int LogicalProcessors, long MemoryBytes,
    IReadOnlyList<string> Gpus, DateTime BootTime, IReadOnlyList<string> Users, IReadOnlyList<DriveDetail> Drives);

/// <summary>드라이브 하나 (Linux는 마운트 지점)</summary>
/// <param name="Type">fixed · removable · network · cdrom · other</param>
/// <param name="Format">파일 시스템 (NTFS · ext4 …)</param>
public record DriveDetail(string Name, string? Label, string Type, string? Format, long FreeBytes, long TotalBytes);

/// <param name="Cpu">CPU 사용률 (PC 전체 대비 0~100)</param>
/// <param name="Memory">Windows: 개인 작업 집합 (작업 관리자의 '메모리'), Linux: 공유 페이지를 뺀 상주 메모리</param>
public record ProcessEntry(int Id, string Name, double Cpu, long Memory);

/// <param name="Items">프로세스 전부 (System Idle Process·Linux 커널 스레드 제외)</param>
public record ProcessList(IReadOnlyList<ProcessEntry> Items);

/// <summary>성능 1초 측정값. 사용률은 0~100, 속도는 초당 바이트</summary>
/// <param name="Seq">측정 번호 (계속 늘어남)</param>
/// <param name="DiskActive">가장 바쁜 디스크의 활성 시간</param>
/// <param name="Gpu">GPU 사용률 (가장 바쁜 엔진, Windows만). 모르면 null</param>
public record PerfSample(long Seq, double Cpu, long MemoryUsed, long MemoryTotal, double DiskRead, double DiskWrite, double DiskActive,
    double NetReceive, double NetSend, double? Gpu);

/// <param name="Session">측정을 새로 시작할 때마다 바뀐다 (바뀌면 대시보드가 그래프를 새로 그린다)</param>
/// <param name="Samples">요청의 after 다음 측정값 (최근 60개까지)</param>
public record PerfHistory(string Session, IReadOnlyList<PerfSample> Samples);

/// <summary>장치 관리자 한 줄</summary>
/// <param name="Class">종류 (Windows 장치 관리자의 이름 그대로: "디스플레이 어댑터" …)</param>
/// <param name="Problem">0이면 정상. 장치 관리자 문제 코드 (22 사용 안 함, 28 드라이버 없음 …). Linux는 드라이버가 없으면 28</param>
/// <param name="Id">장치 인스턴스 ID (USB\VID_046D&amp;PID_C52B\… · Linux는 sysfs 이름)</param>
public record DeviceEntry(string Class, string Name, string? Manufacturer, int Problem, string? Id);

public record DeviceList(IReadOnlyList<DeviceEntry> Items);

/// <summary>원격조작 WebSocket 경로</summary>
public static class AgentRemotePaths
{
    /// <summary>에이전트의 원격조작 프로세스가 접속한다 (에이전트 토큰 필요)</summary>
    public static string Session(string sessionId) => $"/api/agent/remote/{sessionId}";

    /// <summary>
    /// 원격조작 중에 RDP로 접속해 원격조작이 끝났을 때 에이전트가 돌려주는 오류. 서버는 이 오류면 다시 연결하지 않고 이 사유로 끝낸다
    /// </summary>
    public const string RdpTookOver = "RDP 접속으로 원격조작이 종료되었습니다.";
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
/// <param name="Format">zip · 7z · tar · tar.gz (옛 서버는 보내지 않음 → zip)</param>
public record CompressRequest(string TransferId, IReadOnlyList<string> Paths, string DestinationFolder, string ArchiveName, long SplitBytes = 0, string Format = "zip");

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
/// <param name="Truncated">하위 폴더 검색(SearchFiles)에서 결과가 많거나 오래 걸려 일부만 돌려줬다</param>
public record DirectoryListing(string Path, string? ParentPath, IReadOnlyList<FileEntry> Entries, string? Error, string? ArchivePath = null, bool Truncated = false);

/// <summary>서버 → 에이전트 호출 (응답 없음)</summary>
public interface IAgentClient
{
    Task RunCommand(RunCommandRequest request);
    Task CancelCommand(string runId);
    Task CollectFiles(CollectFilesRequest request);
    Task UploadFile(UploadFileRequest request);
    Task DownloadFile(DownloadFileRequest request);
    Task Compress(CompressRequest request);

    /// <summary>진행 중인 전송(압축·풀기·가져오기·올리기·결과 수집)을 멈춘다. 끝나면 TransferCompleted(실패, "취소했습니다")</summary>
    Task CancelTransfer(string transferId);

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

    /// <summary>string path → string? 오류. 이 PC의 파일을 그 자리에서 기본 프로그램으로 연다 (대시보드를 연 PC 자신의 파일, 공유 폴더의 네트워크 경로)</summary>
    public const string LaunchFile = "LaunchFile";

    /// <summary>() → EditFolderInfo. 편집 폴더 현황</summary>
    public const string GetEditFolderInfo = "GetEditFolderInfo";

    /// <summary>() → string? 오류. 편집 폴더를 사용자 화면에 탐색기로 연다</summary>
    public const string OpenEditFolder = "OpenEditFolder";

    /// <summary>() → EditCleanResult. 다 보냈고 열려 있지 않은 받은 사본을 지운다</summary>
    public const string CleanEditFolder = "CleanEditFolder";

    /// <summary>(string extension, int size) → byte[]? PNG. 그 PC 윈도우의 확장자별 셸 아이콘 (탐색기와 같은 아이콘)</summary>
    public const string GetFileIcon = "GetFileIcon";

    /// <summary>() → string. 내 PC(대시보드를 연 PC): 원격 PC에서 복사한 파일을 받아 둘 새 폴더</summary>
    public const string PrepareClipboard = "PrepareClipboard";

    /// <summary>string[] paths → string? 오류. 내 PC: 받은 파일들을 사용자 클립보드에 '복사'로 넣는다 (Ctrl+V로 붙여넣기)</summary>
    public const string SetClipboardFiles = "SetClipboardFiles";

    /// <summary>string sessionId → string? 오류. 사용자 세션에 원격조작 프로세스를 띄워 AgentRemotePaths.Session으로 접속시킨다</summary>
    public const string StartRemote = "StartRemote";

    /// <summary>string sessionId → string? 오류. 썸네일 모드 프로세스를 띄운다 (Remote 화면의 PC 미리보기)</summary>
    public const string StartThumbnail = "StartThumbnail";

    /// <summary>() → string? 오류. Ctrl+Alt+Del(SAS)을 보낸다 (서비스만 가능)</summary>
    public const string SendSecureAttention = "SendSecureAttention";

    /// <summary>() → string? 오류. Linux: 로그인 관리자(GDM)의 Wayland를 끄고(Xorg 사용) 재부팅한다 (원격조작은 X11에서만 됨)</summary>
    public const string SwitchToX11 = "SwitchToX11";

    /// <summary>string serverUrl → string? 오류. 새 서버가 응답하면 잠시 뒤 서버 주소를 바꿔 그 서버로 다시 연결한다 (설정 '서버 주소 일괄 변경')</summary>
    public const string SetServerUrl = "SetServerUrl";

    /// <summary>(string path, double startSec, double endSec) → VideoTrimResult. 영상 구간을 ffmpeg로 잘라 원래 영상 폴더에 저장 (결과 확인 도구)</summary>
    public const string TrimVideo = "TrimVideo";
    /// <summary>(string path, bool convert) → VideoPrepareResult. 영상 길이·fps를 읽고, convert면 탐색 가능한 재생용 사본을 만든다 (캐시)</summary>
    public const string PrepareVideo = "PrepareVideo";
    /// <summary>(string path) → VideoPrepareProgress? 이 영상의 재생 준비 진행 (사본 만드는 중·ffmpeg 받는 중이 아니면 null)</summary>
    public const string GetPrepareProgress = "GetPrepareProgress";
    /// <summary>() → VideoStorageInfo. 드라이브 남은 공간과 재생용 사본 목록</summary>
    public const string GetVideoStorage = "GetVideoStorage";
    /// <summary>(string[] names) → VideoCacheDeleteResult. 재생용 사본 지우기 (원본은 그대로)</summary>
    public const string DeleteVideoCache = "DeleteVideoCache";
    /// <summary>(ImageSearchRequest) → string 작업 id. 영상들에서 크롭 이미지 유사도 찾기를 뒤에서 시작 (진행은 GetImageSearch)</summary>
    public const string StartImageSearch = "StartImageSearch";
    /// <summary>(string id, int have) → ImageSearchStatus? (없는 작업이면 null). have: 이미 받은 영상 수. 옛 대시보드용 (긴 영상은 2MB를 넘어 연결이 끊긴다)</summary>
    public const string GetImageSearch = "GetImageSearch";
    /// <summary>(string id, int video, int offset) → ImageSearchProgress? 진행과 (video, offset)부터의 결과 조각 (한 번에 1MB까지)</summary>
    public const string GetImageSearchChunks = "GetImageSearchChunks";
    /// <summary>(string id) → bool. 이미지 찾기 멈춤</summary>
    public const string CancelImageSearch = "CancelImageSearch";
    /// <summary>(VideoAnalysisRequest) → string 작업 id. 영상들의 프레임별 밝기·윤곽·변화량 재기를 뒤에서 시작</summary>
    public const string StartVideoAnalysis = "StartVideoAnalysis";
    /// <summary>(string id, int video, int offset) → VideoAnalysisProgress? 진행과 (video, offset 프레임)부터의 결과 조각 (한 번에 1MB까지)</summary>
    public const string GetVideoAnalysisChunks = "GetVideoAnalysisChunks";
    /// <summary>(string id) → bool. 영상 분석 멈춤 (거기까지 잰 결과는 남는다)</summary>
    public const string CancelVideoAnalysis = "CancelVideoAnalysis";
    /// <summary>() → PcSystemInfo. PC 정보 패널: 시스템 정보·드라이브</summary>
    public const string GetSystemInfo = "GetSystemInfo";
    /// <summary>() → ProcessList. CPU는 저번 목록과 비교해 잰다 (1.5초 안에 다시 물으면 같은 목록)</summary>
    public const string GetProcesses = "GetProcesses";
    /// <summary>(long after) → PerfHistory. 첫 요청에 1초 간격 측정을 시작하고, 10초 동안 묻지 않으면 멈춘다</summary>
    public const string GetPerformance = "GetPerformance";
    /// <summary>() → DeviceList. 장치 관리자 목록 (숨긴 장치 제외)</summary>
    public const string GetDevices = "GetDevices";
    /// <summary>
    /// (string streamId, string path, long offset, long length) → bool. 파일 구간을 HTTP POST(AgentTransferPaths.MediaStream)로 서버에 흘려보낸다.
    /// 브라우저 영상 재생용: SignalR 조각 중계보다 훨씬 빠르다. 시작하면 바로 true (보내기는 뒤에서), 못 열면 false. 옛 에이전트는 없음 → 조각 중계로
    /// </summary>
    public const string StreamFileRange = "StreamFileRange";
    /// <summary>(string root, string query, int max) → DirectoryListing. root 아래(하위 폴더까지)에서 이름에 query가 든 파일·폴더를 찾는다 (최대 max개)</summary>
    public const string SearchFiles = "SearchFiles";
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
