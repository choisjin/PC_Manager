namespace PcManager.Server.Contracts;

/// <summary>서버가 직접 접근하는 공유 폴더(네트워크 UNC 또는 로컬 경로). Username은 표시용, 비밀번호는 응답에 포함하지 않는다.</summary>
public record SharedFolder(string Id, string Name, string Path, string? Username = null);

public record SharedFoldersView(IReadOnlyList<SharedFolder> Shares);

/// <param name="Username">네트워크 공유 자격증명(선택)</param>
/// <param name="Password">네트워크 공유 비밀번호(선택). 서버에 DPAPI로 암호화 저장</param>
public record AddSharedFolderRequest(string? Name, string? Path, string? Username, string? Password);
