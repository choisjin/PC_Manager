using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>프로젝트·사용자·할당을 서버에 저장한다 (모든 대시보드 공유).</summary>
public class OrgStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "org.json");

    private static OrgView Empty => new([], [], new Dictionary<string, IReadOnlyList<string>>(), new Dictionary<string, string>());

    public OrgView Load()
    {
        lock (_lock)
        {
            return LoadUnlocked();
        }
    }

    private OrgView LoadUnlocked()
    {
        if (!File.Exists(_path))
            return Empty;
        try
        {
            return JsonSerializer.Deserialize<OrgView>(File.ReadAllText(_path), Json) ?? Empty;
        }
        catch (JsonException)
        {
            return Empty;
        }
    }

    private OrgView Mutate(Func<Model, Model> change)
    {
        lock (_lock)
        {
            var model = Model.From(LoadUnlocked());
            var next = change(model);
            var view = next.ToView();
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(view, Json));
            File.Move(temp, _path, overwrite: true);
            return view;
        }
    }

    public OrgView AddProject(string name)
    {
        var clean = Clean(name, "프로젝트 이름");
        return Mutate(m =>
        {
            m.Projects.Add(new Project(Guid.NewGuid().ToString("N"), clean));
            return m;
        });
    }

    public OrgView RenameProject(string id, string name)
    {
        var clean = Clean(name, "프로젝트 이름");
        return Mutate(m =>
        {
            var idx = m.Projects.FindIndex(p => p.Id == id);
            if (idx >= 0)
                m.Projects[idx] = m.Projects[idx] with { Name = clean };
            return m;
        });
    }

    public OrgView DeleteProject(string id) => Mutate(m =>
    {
        m.Projects.RemoveAll(p => p.Id == id);
        m.ProjectUsers.Remove(id);
        foreach (var agentId in m.AgentProjects.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList())
            m.AgentProjects.Remove(agentId);
        return m;
    });

    public OrgView AddUser(string name)
    {
        var clean = Clean(name, "사용자 이름");
        return Mutate(m =>
        {
            m.Users.Add(new OrgUser(Guid.NewGuid().ToString("N"), clean));
            return m;
        });
    }

    public OrgView DeleteUser(string id) => Mutate(m =>
    {
        m.Users.RemoveAll(u => u.Id == id);
        foreach (var key in m.ProjectUsers.Keys.ToList())
            m.ProjectUsers[key] = m.ProjectUsers[key].Where(uid => uid != id).ToList();
        return m;
    });

    public OrgView SetProjectUsers(string projectId, IReadOnlyList<string> userIds) => Mutate(m =>
    {
        if (m.Projects.Any(p => p.Id == projectId))
        {
            var known = m.Users.Select(u => u.Id).ToHashSet();
            m.ProjectUsers[projectId] = userIds.Where(known.Contains).Distinct().ToList();
        }
        return m;
    });

    public OrgView SetAgentProject(string agentId, string? projectId) => Mutate(m =>
    {
        if (string.IsNullOrWhiteSpace(projectId) || !m.Projects.Any(p => p.Id == projectId))
            m.AgentProjects.Remove(agentId);
        else
            m.AgentProjects[agentId] = projectId;
        return m;
    });

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

        public static Model From(OrgView v) => new()
        {
            Projects = v.Projects.ToList(),
            Users = v.Users.ToList(),
            ProjectUsers = (v.ProjectUsers ?? new Dictionary<string, IReadOnlyList<string>>())
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToList()),
            AgentProjects = (v.AgentProjects ?? new Dictionary<string, string>())
                .ToDictionary(kv => kv.Key, kv => kv.Value),
        };

        public OrgView ToView() => new(
            Projects,
            Users,
            ProjectUsers.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value),
            AgentProjects);
    }
}
