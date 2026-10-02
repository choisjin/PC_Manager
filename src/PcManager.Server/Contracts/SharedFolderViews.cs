namespace PcManager.Server.Contracts;

/// <summary>서버가 직접 접근하는 공유 폴더 (네트워크 공유 또는 서버 로컬 폴더). 비밀번호는 내보내지 않는다.</summary>
/// <param name="OwnerUserId">등록한 사용자. null이면 예전에 등록된 공용 공유 폴더 (모든 사용자에게 보임)</param>
public record SharedFolder(string Id, string Name, string Path, string? Username = null, string? OwnerUserId = null);

public record SharedFoldersView(IReadOnlyList<SharedFolder> Shares);

/// <param name="Username">자격증명 없이 열리지 않는 폴더는 필수. "도메인\사용자", "사용자@도메인" 또는 "사용자"</param>
public record AddSharedFolderRequest(string? Name, string? Path, string? Username, string? Password);

public record RenameSharedFolderRequest(string? Name);

public record ShareProbeRequest(string? Path);

/// <param name="Accessible">서버 계정으로(자격증명 없이) 열린다</param>
/// <param name="NeedsCredentials">폴더는 있는데 권한이 없다 → 사용자 이름·비밀번호 필요</param>
/// <param name="Error">경로가 없거나 서버에 연결할 수 없는 등 (자격증명으로 해결되지 않을 수 있음)</param>
public record ShareProbeResult(bool Accessible, bool NeedsCredentials, string? Error);
