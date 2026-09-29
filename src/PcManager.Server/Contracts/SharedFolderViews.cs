namespace PcManager.Server.Contracts;

/// <summary>서버가 직접 접근하는 공유 폴더(네트워크 UNC 또는 로컬 경로)</summary>
public record SharedFolder(string Id, string Name, string Path);

public record SharedFoldersView(IReadOnlyList<SharedFolder> Shares);

public record AddSharedFolderRequest(string? Name, string? Path);
