namespace PcManager.Server.Contracts;

/// <param name="Content">줄바꿈을 \n으로 맞춘 내용</param>
/// <param name="Encoding">utf-8 | utf-8-bom | utf-16le | utf-16be | cp949</param>
/// <param name="Newline">원래 줄바꿈 (\r\n 또는 \n). 저장할 때 되돌린다</param>
/// <param name="Hash">읽은 시점의 내용 해시. 저장 시 다른 곳에서 바뀌었는지 비교한다</param>
public record TextFileView(string Content, string Encoding, string Newline, string Hash, long Size);

/// <param name="BaseHash">편집을 시작한 시점의 해시. null이면 비교하지 않고 덮어쓴다</param>
/// <param name="Backup">저장 전 원본을 "파일.bak"으로 남긴다</param>
public record SaveTextRequest(string Path, string Content, string? Encoding, string? Newline, string? BaseHash, bool Backup);

/// <param name="Conflict">편집하는 동안 다른 곳에서 파일이 바뀌어 저장하지 않았다</param>
public record SaveTextResult(bool Success, bool Conflict, string? Error, string? Hash);

public record EncodeTextRequest(string Content, string? Encoding, string? Newline);

/// <param name="ArchivePath">압축 파일 경로</param>
/// <param name="EntryPaths">풀 항목의 전체 경로("a.zip\폴더\파일"). 비면 전부</param>
/// <param name="DestinationFolder">풀 폴더 (같은 PC)</param>
public record ExtractFilesRequest(string? ArchivePath, IReadOnlyList<string>? EntryPaths, string? DestinationFolder);

public record ArchivePasswordRequest(string? ArchivePath, string? Password);

/// <param name="EditorAgentId">대시보드를 연 PC의 에이전트 (그 PC 프로그램으로 연다)</param>
/// <param name="Label">편집 폴더 이름에 쓸 원래 PC 표시 이름</param>
/// <param name="ReadOnly">압축 안 파일 등: 열기만 하고 되돌려 저장하지 않음</param>
/// <param name="Backup">저장할 때 원본을 .bak으로 남긴다 (선택)</param>
public record ClipboardFilesRequest(IReadOnlyList<string>? Paths);

public record OpenLocalRequest(string? Path, string? EditorAgentId, string? Label, bool ReadOnly, bool Backup = false);
