using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 프로젝트·사용자·권한·할당을 서버에 저장한다 (org.json, 모든 대시보드 공유).
/// - 프로젝트마다 관리자 계정 1개 (Id admin@{projectId}, 이름 '관리자'). 비밀번호는 AuthStore
/// - LG 계정으로 로그인한 사람은 사용자 목록에 저장. 그 프로젝트에 처음 로그인하면 전체 기능,
///   관리자가 Setting › 인원 권한에서 조정하면 PermReviewed 에 기록 (조정 전 = 미분류)
/// - 멤버(ProjectUsers) = 관리자 + 그 프로젝트 기능이 하나라도 있는 사용자
/// </summary>
public class OrgStore(AppPaths paths)
{
    public const int CurrentSchema = 2;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "org.json");

    private static OrgView Empty => new([], [], new Dictionary<string, IReadOnlyList<string>>(), new Dictionary<string, string>());

    public static string AdminId(string projectId) => $"admin@{projectId}";

    public OrgView Load()
    {
        lock (_lock)
        {
            var view = LoadUnlocked();
            return view.Schema >= CurrentSchema ? view : Save(Migrate(Model.From(view)));
        }
    }

    private OrgView LoadUnlocked()
    {
        if (!File.Exists(_path))
            return Empty with { Schema = CurrentSchema };
        try
        {
            return JsonSerializer.Deserialize<OrgView>(File.ReadAllText(_path), Json) ?? Empty;
        }
        catch (JsonException)
        {
            return Empty;
        }
    }

    /// <summary>
    /// 이름 선택 로그인(비밀번호 없음) → LG 계정 로그인으로 바꾸며 한 번만: 기존 이름 사용자·배정은 버리고 새로 시작.
    /// 프로젝트·PC/폴더 배정은 그대로 두고, 프로젝트마다 관리자 계정을 만든다.
    /// </summary>
    private static Model Migrate(Model m)
    {
        if (m.Schema < CurrentSchema)
        {
            m.Users.Clear();
            m.ProjectUsers.Clear();
            m.ProjectPerms.Clear();
            m.PermReviewed.Clear();
            foreach (var p in m.Projects)
                EnsureAdmin(m, p.Id);
            m.Schema = CurrentSchema;
        }
        return m;
    }

    private OrgView Save(Model model)
    {
        var view = model.ToView();
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(view, Json));
        File.Move(temp, _path, overwrite: true);
        return view;
    }

    private OrgView Mutate(Action<Model> change)
    {
        lock (_lock)
        {
            var model = Migrate(Model.From(LoadUnlocked()));
            change(model);
            return Save(model);
        }
    }

    // ── 프로젝트 ──

    public (OrgView View, Project Project) AddProject(string name)
    {
        var clean = Clean(name, "프로젝트 이름");
        Project? created = null;
        var view = Mutate(m =>
        {
            if (m.Projects.Any(p => p.Name == clean))
                throw new ArgumentException("이미 같은 이름의 프로젝트가 있습니다.");
            created = new Project(Guid.NewGuid().ToString("N"), clean, DateTimeOffset.Now);
            m.Projects.Add(created);
            EnsureAdmin(m, created.Id);
        });
        return (view, created!);
    }

    public OrgView RenameProject(string id, string name)
    {
        var clean = Clean(name, "프로젝트 이름");
        return Mutate(m =>
        {
            var idx = m.Projects.FindIndex(p => p.Id == id);
            if (idx < 0)
                throw new KeyNotFoundException("프로젝트를 찾을 수 없습니다.");
            if (m.Projects.Any(p => p.Name == clean && p.Id != id))
                throw new ArgumentException("이미 같은 이름의 프로젝트가 있습니다.");
            m.Projects[idx] = m.Projects[idx] with { Name = clean };
        });
    }

    public OrgView DeleteProject(string id) => Mutate(m =>
    {
        if (!m.Projects.Any(p => p.Id == id))
            throw new KeyNotFoundException("프로젝트를 찾을 수 없습니다.");
        if (m.Projects.Count <= 1)
            throw new ArgumentException("마지막 프로젝트는 삭제할 수 없습니다.");
        m.Projects.RemoveAll(p => p.Id == id);
        m.Users.RemoveAll(u => u.Id == AdminId(id));
        m.ProjectUsers.Remove(id);
        m.ProjectPerms.Remove(id);
        m.PermReviewed.Remove(id);
        foreach (var agentId in m.AgentProjects.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList())
            m.AgentProjects.Remove(agentId);
        foreach (var folderId in m.FolderProjects.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList())
            m.FolderProjects.Remove(folderId);
    });

    // ── 사용자 · 권한 ──

    public record LdapProfile(string LdapId, string Name, string? Title, string? Team, string? Department, string? Email);

    /// <summary>LG 계정 로그인 성공 → 사용자 저장(없으면 추가, 있으면 정보 갱신). 그 프로젝트에 처음이면 전체 기능</summary>
    public OrgUser UpsertLdapUser(string projectId, LdapProfile profile)
    {
        OrgUser? user = null;
        Mutate(m =>
        {
            if (!m.Projects.Any(p => p.Id == projectId))
                throw new KeyNotFoundException("프로젝트를 찾을 수 없습니다.");
            var id = profile.LdapId.ToLowerInvariant();
            var idx = m.Users.FindIndex(u => u.Id == id);
            var existing = idx >= 0 ? m.Users[idx] : null;
            // 동명이인은 이름 뒤에 계정 ID (이미 있는 사용자는 이름 유지)
            var name = existing?.Name
                ?? (m.Users.Any(u => u.Name == profile.Name) ? $"{profile.Name}({profile.LdapId})" : profile.Name);
            user = new OrgUser(
                id,
                name,
                "user",
                null,
                profile.LdapId,
                profile.Title ?? existing?.Title,
                profile.Team ?? existing?.Team,
                profile.Department ?? existing?.Department,
                string.IsNullOrEmpty(profile.Email) ? existing?.Email : profile.Email,
                DateTimeOffset.Now);
            if (idx >= 0)
                m.Users[idx] = user;
            else
                m.Users.Add(user);
            var perms = PermsOfProject(m, projectId);
            if (!perms.ContainsKey(id))
            {
                perms[id] = Features.All.ToList();
                SyncMembers(m, projectId);
            }
        });
        return user!;
    }

    /// <summary>사용자 1명의 이 프로젝트 기능 저장 (빈 목록 = 권한 없음, 이후 로그인해도 유지)</summary>
    public OrgView SetUserPerms(string projectId, string userId, IReadOnlyList<string> features) => Mutate(m =>
    {
        if (!m.Projects.Any(p => p.Id == projectId))
            throw new KeyNotFoundException("프로젝트를 찾을 수 없습니다.");
        if (!m.Users.Any(u => u.Id == userId && u.Role != OrgUser.AdminRole))
            throw new KeyNotFoundException("사용자를 찾을 수 없습니다.");
        PermsOfProject(m, projectId)[userId] = Features.Clean(features).ToList();
        if (!m.PermReviewed.TryGetValue(projectId, out var reviewed))
            m.PermReviewed[projectId] = reviewed = [];
        if (!reviewed.Contains(userId))
            reviewed.Add(userId);
        SyncMembers(m, projectId);
    });

    /// <summary>사용자가 이 프로젝트에서 쓸 수 있는 기능 (관리자는 전부)</summary>
    public static IReadOnlyList<string> PermsOf(OrgView view, OrgUser user, string projectId)
    {
        if (user.Role == OrgUser.AdminRole)
            return user.ProjectId == projectId ? Features.All : [];
        return view.ProjectPerms?.GetValueOrDefault(projectId)?.GetValueOrDefault(user.Id) is { } list ? Features.Clean(list) : [];
    }

    // ── PC · 폴더 배정 ──

    public OrgView SetFolderProject(string folderId, string? projectId) => Mutate(m =>
    {
        if (string.IsNullOrWhiteSpace(projectId) || !m.Projects.Any(p => p.Id == projectId))
            m.FolderProjects.Remove(folderId);
        else
            m.FolderProjects[folderId] = projectId;
    });

    public OrgView SetAgentProject(string agentId, string? projectId) => Mutate(m =>
    {
        if (string.IsNullOrWhiteSpace(projectId) || !m.Projects.Any(p => p.Id == projectId))
            m.AgentProjects.Remove(agentId);
        else
            m.AgentProjects[agentId] = projectId;
    });

    // ── 내부 ──

    private static void EnsureAdmin(Model m, string projectId)
    {
        var id = AdminId(projectId);
        if (!m.Users.Any(u => u.Id == id))
            m.Users.Add(new OrgUser(id, "관리자", OrgUser.AdminRole, projectId));
        SyncMembers(m, projectId);
    }

    private static Dictionary<string, List<string>> PermsOfProject(Model m, string projectId)
    {
        if (!m.ProjectPerms.TryGetValue(projectId, out var perms))
            m.ProjectPerms[projectId] = perms = [];
        return perms;
    }

    private static void SyncMembers(Model m, string projectId)
    {
        var perms = m.ProjectPerms.GetValueOrDefault(projectId) ?? [];
        m.ProjectUsers[projectId] = [AdminId(projectId), .. perms.Where(kv => kv.Value.Count > 0).Select(kv => kv.Key)];
    }

    private static string Clean(string? value, string what)
    {
        var trimmed = (value ?? "").Trim();
        if (trimmed.Length == 0)
            throw new ArgumentException($"{what}을(를) 입력하세요.");
        return trimmed.Length > 60 ? trimmed[..60] : trimmed;
    }

    private sealed class Model
    {
        public required List<Project> Projects { get; init; }
        public required List<OrgUser> Users { get; init; }
        public required Dictionary<string, List<string>> ProjectUsers { get; init; }
        public required Dictionary<string, string> AgentProjects { get; init; }
        public required Dictionary<string, string> FolderProjects { get; init; }
        public required Dictionary<string, Dictionary<string, List<string>>> ProjectPerms { get; init; }
        public required Dictionary<string, List<string>> PermReviewed { get; init; }
        public int Schema { get; set; }

        public static Model From(OrgView v) => new()
        {
            Projects = v.Projects.ToList(),
            Users = v.Users.ToList(),
            ProjectUsers = (v.ProjectUsers ?? new Dictionary<string, IReadOnlyList<string>>())
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToList()),
            AgentProjects = (v.AgentProjects ?? new Dictionary<string, string>())
                .ToDictionary(kv => kv.Key, kv => kv.Value),
            FolderProjects = (v.FolderProjects ?? new Dictionary<string, string>())
                .ToDictionary(kv => kv.Key, kv => kv.Value),
            ProjectPerms = (v.ProjectPerms ?? new Dictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>>())
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToDictionary(p => p.Key, p => p.Value.ToList())),
            PermReviewed = (v.PermReviewed ?? new Dictionary<string, IReadOnlyList<string>>())
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToList()),
            Schema = v.Schema,
        };

        public OrgView ToView() => new(
            Projects,
            Users,
            ProjectUsers.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value),
            AgentProjects,
            FolderProjects,
            ProjectPerms.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyDictionary<string, IReadOnlyList<string>>)kv.Value.ToDictionary(p => p.Key, p => (IReadOnlyList<string>)p.Value)),
            PermReviewed.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value),
            Schema);
    }
}
