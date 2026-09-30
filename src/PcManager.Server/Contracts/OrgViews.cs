namespace PcManager.Server.Contracts;

public record Project(string Id, string Name);

public record OrgUser(string Id, string Name);

/// <summary>프로젝트·사용자·할당 전체 상태</summary>
public record OrgView(
    IReadOnlyList<Project> Projects,
    IReadOnlyList<OrgUser> Users,
    /// <summary>projectId → 할당된 userId 목록</summary>
    IReadOnlyDictionary<string, IReadOnlyList<string>> ProjectUsers,
    /// <summary>agentId → projectId (없으면 미배정=공용)</summary>
    IReadOnlyDictionary<string, string> AgentProjects,
    /// <summary>PC 목록 폴더 id → projectId. 배정된 폴더는 그 프로젝트 사용자에게만 보인다 (없으면 공용)</summary>
    IReadOnlyDictionary<string, string>? FolderProjects = null);

public record NameRequest(string? Name);

public record AssignProjectUsersRequest(IReadOnlyList<string>? UserIds);

public record AssignAgentProjectRequest(string? ProjectId);
