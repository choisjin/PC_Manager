namespace PcManager.Server.Contracts;

/// <param name="ParentId">상위 폴더 ID. null이면 최상위</param>
public record PcGroupFolder(string Id, string Name, string? ParentId, int Order);

/// <param name="Assignments">agentId → folderId. 없는 PC는 미분류(최상위)</param>
public record PcGroupsView(
    IReadOnlyList<PcGroupFolder> Folders,
    IReadOnlyDictionary<string, string> Assignments);
