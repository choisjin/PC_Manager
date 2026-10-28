namespace PcManager.Server.Contracts;

public record Project(string Id, string Name, DateTimeOffset? CreatedAt = null);

/// <summary>
/// 사용자. LG 계정(LDAP)으로 로그인한 사람(Id = 계정 ID 소문자) 또는 프로젝트 관리자(Id = admin@{projectId}).
/// 비밀번호는 여기에 두지 않는다 (모든 대시보드에 방송되므로) — 관리자 비밀번호는 AuthStore.
/// </summary>
public record OrgUser(
    string Id,
    string Name,
    string? Role = null,
    /// <summary>관리자 계정이 묶인 프로젝트 (관리자만)</summary>
    string? ProjectId = null,
    string? LdapId = null,
    string? Title = null,
    string? Team = null,
    string? Department = null,
    string? Email = null,
    DateTimeOffset? LastLogin = null)
{
    public const string AdminRole = "admin";
}

/// <summary>프로젝트·사용자·할당 전체 상태</summary>
public record OrgView(
    IReadOnlyList<Project> Projects,
    IReadOnlyList<OrgUser> Users,
    /// <summary>projectId → 멤버 userId 목록 (관리자 + 그 프로젝트 기능이 하나라도 있는 사용자)</summary>
    IReadOnlyDictionary<string, IReadOnlyList<string>> ProjectUsers,
    /// <summary>agentId → projectId (없으면 미배정=공용)</summary>
    IReadOnlyDictionary<string, string> AgentProjects,
    /// <summary>PC 목록 폴더 id → projectId. 배정된 폴더는 그 프로젝트 사용자에게만 보인다 (없으면 공용)</summary>
    IReadOnlyDictionary<string, string>? FolderProjects = null,
    /// <summary>projectId → (userId → 쓸 수 있는 기능 id). 그 프로젝트에 처음 로그인하면 전체 기능</summary>
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>>? ProjectPerms = null,
    /// <summary>projectId → 관리자가 권한을 조정한 userId (조정 전 = 미분류)</summary>
    IReadOnlyDictionary<string, IReadOnlyList<string>>? PermReviewed = null,
    /// <summary>저장 형식 버전 (2 = LG 계정 로그인)</summary>
    int Schema = 0,
    /// <summary>
    /// projectId → (userId → 볼 수 있는 PC 목록 폴더 id, "ungrouped" = 미분류 PC). 없는 사용자는 모든 폴더.
    /// 고른 폴더 아래에 새로 만든 폴더와 자기가 만든 폴더는 저절로 들어간다
    /// </summary>
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>>? ProjectFolderPerms = null);

public record NameRequest(string? Name);

public record AssignAgentProjectRequest(string? ProjectId);

// --- 로그인 ---

public record LoginRequest(string? ProjectId, string? Username, string? Password, bool Remember);

public record TokenRequest(string? Token);

/// <summary>APMS 자동 로그인: APMS 포털이 준 1회용 표 + 대시보드를 연 APMS 주소(origin)</summary>
public record ApmsSsoRequest(string? Ticket, string? ApmsOrigin);

public record LogoutRequest(string? Remember);

public record ChangePasswordRequest(string? Old, string? New);

public record ProjectPasswordRequest(string? Name, string? Password);

public record SetPermsRequest(IReadOnlyList<string>? Perms);

/// <summary>PC 목록 폴더 권한: null = 모든 폴더, 목록 = 그 폴더의 PC만</summary>
public record SetFolderPermsRequest(IReadOnlyList<string>? Folders);

/// <summary>
/// 로그인 결과: 세션 토큰 · 사용자 · 프로젝트 · 쓸 수 있는 기능 · 볼 수 있는 PC 목록 폴더(null = 모두)
/// (자동 로그인이면 remember 토큰)
/// </summary>
public record LoginResult(string Token, OrgUser User, Project Project, IReadOnlyList<string> Perms, string? Remember = null, IReadOnlyList<string>? Folders = null);

public record MeResult(OrgUser User, Project Project, IReadOnlyList<string> Perms, IReadOnlyList<string>? Folders = null);
