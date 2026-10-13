using System.Net;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>
/// 로그인(APMS 방식) · 프로젝트 · 인원 권한 · PC/폴더 배정.
/// 'admin' = 그 프로젝트 관리자 (기본 비밀번호 admin), 그 외 ID = LG 계정(LDAP).
/// 권한은 화면에서만 적용한다 (다른 API는 로그인을 검사하지 않음).
/// </summary>
public static partial class OrgEndpoints
{
    private const int MinPasswordLength = 4;

    public static void MapOrgApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/org", (OrgStore store) => Results.Ok(store.Load()));

        // --- 로그인 ---

        api.MapPost("/auth/login", (LoginRequest req, OrgStore store, AuthStore auth, LdapAuthenticator ldap) =>
        {
            var projectId = (req.ProjectId ?? "").Trim();
            var view = store.Load();
            var project = view.Projects.FirstOrDefault(p => p.Id == projectId);
            if (project is null)
                return Error(400, "프로젝트를 선택하세요.");
            var username = (req.Username ?? "").Trim();
            var at = username.IndexOf('@');
            if (at >= 0)
                username = username[..at]; // 이메일로 넣어도 ID만
            var password = req.Password ?? "";
            if (username.Length == 0 || password.Length == 0)
                return Error(400, "계정 ID와 비밀번호를 입력하세요.");

            if (username.Equals("admin", StringComparison.OrdinalIgnoreCase))
            {
                bool ok;
                try
                {
                    ok = auth.VerifyAdmin(projectId, password);
                }
                catch (InvalidOperationException ex)
                {
                    return Error(429, ex.Message);
                }
                var admin = view.Users.FirstOrDefault(u => u.Id == OrgStore.AdminId(projectId));
                if (!ok || admin is null)
                    return Error(401, "관리자 비밀번호가 올바르지 않습니다.");
                return Results.Ok(Issue(auth, view, admin, project, req.Remember));
            }

            if (!LdapAuthenticator.ValidId(username))
                return Error(400, "ID는 영문·숫자·. _ - 만 쓸 수 있습니다 (예: gildong.hong).");
            var result = ldap.Authenticate(username, password);
            if (!result.Success || result.Profile is null)
                return Error(401, result.Reason);
            var user = store.UpsertLdapUser(projectId, result.Profile);
            return Results.Ok(Issue(auth, store.Load(), user, project, req.Remember));
        });

        api.MapPost("/auth/auto-login", (TokenRequest req, OrgStore store, AuthStore auth) =>
        {
            var session = auth.UseRemember(req.Token);
            if (session is null)
                return Error(401, "자동 로그인이 만료되었습니다. 다시 로그인하세요.");
            var view = store.Load();
            var user = view.Users.FirstOrDefault(u => u.Id == session.UserId);
            var project = view.Projects.FirstOrDefault(p => p.Id == session.ProjectId);
            if (user is null || project is null || (user.ProjectId is not null && user.ProjectId != project.Id))
            {
                auth.RevokeRemember(req.Token);
                return Error(401, "자동 로그인 정보가 더 이상 유효하지 않습니다. 다시 로그인하세요.");
            }
            return Results.Ok(Issue(auth, view, user, project, remember: false));
        });

        // APMS 안에 넣은 대시보드: APMS 로그인을 그대로 이어받는다.
        // APMS 포털이 준 1회용 표를 그 포털(/api/pcm/sso-verify)에 확인 → APMS 프로젝트 이름과 같은 프로젝트에
        // APMS 관리자는 그 프로젝트 관리자로, 사내 계정 사용자는 같은 LG 계정으로 로그인 (접근 제어는 LDAP 로그인과 같게)
        api.MapPost("/auth/apms-sso", async (ApmsSsoRequest req, OrgStore store, AuthStore auth, LdapAuthenticator ldap,
            IOptions<ServerOptions> options, ILoggerFactory loggers) =>
        {
            var ticket = (req.Ticket ?? "").Trim();
            if (!TicketRegex().IsMatch(ticket))
                return Error(400, "자동 로그인 정보가 올바르지 않습니다.");
            var verifyBase = ApmsVerifyBase(options.Value.ApmsUrl, req.ApmsOrigin);
            if (verifyBase is null)
                return Error(403, "이 APMS 주소는 자동 로그인을 허용하지 않습니다. (서버 설정 Server:ApmsUrl 에 APMS 주소를 넣으세요)");

            JsonElement info;
            try
            {
                using var resp = await ApmsHttp.GetAsync($"{verifyBase}/api/pcm/sso-verify?ticket={Uri.EscapeDataString(ticket)}");
                if (!resp.IsSuccessStatusCode)
                    return Error(401, "APMS 자동 로그인이 만료되었습니다. APMS 화면을 새로 고치세요.");
                using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
                info = doc.RootElement.GetProperty("user").Clone();
            }
            catch (Exception ex)
            {
                loggers.CreateLogger("ApmsSso").LogWarning("APMS 확인 실패 {Base}: {Message}", verifyBase, ex.Message);
                return Error(502, "APMS 포털에 로그인 확인을 하지 못했습니다.");
            }

            string? Str(JsonElement e, string name) =>
                e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                    ? (string.IsNullOrWhiteSpace(v.GetString()) ? null : v.GetString()!.Trim()) : null;
            var wsName = info.TryGetProperty("workspace", out var ws) ? Str(ws, "name") : null;
            var view = store.Load();
            var project = view.Projects.FirstOrDefault(p => string.Equals(p.Name.Trim(), wsName, StringComparison.OrdinalIgnoreCase))
                ?? (view.Projects.Count == 1 ? view.Projects[0] : null);
            if (project is null)
                return Error(404, $"RemoteKit 에 '{wsName}' 프로젝트가 없습니다. [관리]에서 같은 이름으로 등록하거나 직접 로그인하세요.");

            var isAdmin = info.TryGetProperty("admin", out var a) && a.ValueKind == JsonValueKind.True;
            if (isAdmin)
            {
                var admin = view.Users.FirstOrDefault(u => u.Id == OrgStore.AdminId(project.Id));
                if (admin is null)
                    return Error(404, "프로젝트 관리자 계정을 찾을 수 없습니다.");
                return Results.Ok(Issue(auth, view, admin, project, remember: false));
            }

            var ldapId = Str(info, "ldapId") ?? "";
            if (!LdapAuthenticator.ValidId(ldapId))
                return Error(400, "사내 계정으로 로그인한 APMS 사용자만 자동 로그인할 수 있습니다.");
            var profile = new OrgStore.LdapProfile(ldapId, Str(info, "name") ?? ldapId, Str(info, "title"), Str(info, "team"),
                Str(info, "department"), Str(info, "email"));
            var access = ldap.CheckAccess(ldapId, profile);
            if (!access.Success)
                return Error(403, access.Reason);
            var user = store.UpsertLdapUser(project.Id, profile);
            return Results.Ok(Issue(auth, store.Load(), user, project, remember: false));
        });

        api.MapPost("/auth/logout", (HttpContext context, LogoutRequest? req, AuthStore auth) =>
        {
            auth.DropSession(context);
            auth.RevokeRemember(req?.Remember); // 이 브라우저의 자동 로그인도 해제
            return Results.Ok();
        });

        api.MapGet("/auth/me", (HttpContext context, OrgStore store, AuthStore auth) =>
        {
            var (view, user, project) = Current(context, store, auth);
            if (user is null || project is null)
                return Error(401, "로그인이 필요합니다.");
            return Results.Ok(new MeResult(user, project, OrgStore.PermsOf(view, user, project.Id)));
        });

        // 지금 프로젝트 관리자 비밀번호 변경 (관리자 로그인 상태)
        api.MapPut("/auth/admin-password", (HttpContext context, ChangePasswordRequest req, OrgStore store, AuthStore auth) =>
        {
            var (_, user, project) = Current(context, store, auth);
            if (user?.Role != OrgUser.AdminRole || project is null)
                return Error(403, "관리자 권한이 필요합니다.");
            bool ok;
            try
            {
                ok = auth.VerifyAdmin(project.Id, req.Old);
            }
            catch (InvalidOperationException ex)
            {
                return Error(429, ex.Message);
            }
            if (!ok)
                return Error(403, "현재 비밀번호가 올바르지 않습니다.");
            if ((req.New ?? "").Length < MinPasswordLength)
                return Error(400, $"새 비밀번호는 {MinPasswordLength}자 이상으로 입력하세요.");
            auth.SetAdminPassword(project.Id, req.New!);
            return Results.Ok();
        });

        // 인원 권한: 사용자 1명의 지금 프로젝트 기능 저장 (관리자)
        api.MapPut("/auth/perms/{userId}", async (HttpContext context, string userId, SetPermsRequest req, OrgStore store, AuthStore auth, IHubContext<DashboardHub, IDashboardClient> hub) =>
        {
            var (_, user, project) = Current(context, store, auth);
            if (user?.Role != OrgUser.AdminRole || project is null)
                return Error(403, "관리자 권한이 필요합니다.");
            if (req.Perms is null)
                return Error(400, "perms 형식이 올바르지 않습니다.");
            return await Run(hub, () => store.SetUserPerms(project.Id, userId, req.Perms));
        });

        // --- 로그인 화면 [관리]: 프로젝트 등록은 이름만, 이름 수정·삭제는 그 프로젝트 관리자 비밀번호로 ---

        api.MapPost("/auth/projects", async (NameRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await Run(hub, () => store.AddProject(req.Name ?? "").View));

        api.MapPut("/auth/projects/{id}/rename", async (string id, ProjectPasswordRequest req, OrgStore store, AuthStore auth, IHubContext<DashboardHub, IDashboardClient> hub) =>
        {
            if (CheckAdminPassword(auth, id, req.Password) is { } denied)
                return denied;
            return await Run(hub, () => store.RenameProject(id, req.Name ?? ""));
        });

        api.MapPost("/auth/projects/{id}/purge", async (string id, ProjectPasswordRequest req, OrgStore store, AuthStore auth, IHubContext<DashboardHub, IDashboardClient> hub) =>
        {
            if (CheckAdminPassword(auth, id, req.Password) is { } denied)
                return denied;
            var result = await Run(hub, () => store.DeleteProject(id));
            if (result is IStatusCodeHttpResult { StatusCode: 200 })
                auth.RemoveProject(id);
            return result;
        });

        // --- PC · 폴더 배정 ---

        api.MapPut("/agents/{agentId}/project", (string agentId, AssignAgentProjectRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.SetAgentProject(agentId, req.ProjectId)));

        // PC 목록 폴더에 프로젝트 배정 (그 프로젝트 사용자에게만 보임)
        api.MapPut("/folders/{folderId}/project", (string folderId, AssignAgentProjectRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.SetFolderProject(folderId, req.ProjectId)));
    }

    // APMS 확인 요청: APMS 는 자체 서명 인증서를 쓰므로 인증서 검사를 하지 않는다 (확인하는 값은 1회용 표뿐)
    private static readonly HttpClient ApmsHttp = new(new HttpClientHandler
    {
        ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator,
    })
    { Timeout = TimeSpan.FromSeconds(5) };

    [GeneratedRegex(@"^[A-Za-z0-9_\-]{20,100}$")]
    private static partial Regex TicketRegex();

    /// <summary>
    /// 표를 확인할 APMS 주소. 설정(ApmsUrl)이 있으면 그 주소만. 없으면 대시보드를 연 APMS 주소의 호스트가
    /// 이 PC(루프백 · 이 PC 의 IP · PC 이름)일 때만 같은 포트의 127.0.0.1 로 확인한다.
    /// </summary>
    private static string? ApmsVerifyBase(string? configured, string? origin)
    {
        if (!string.IsNullOrWhiteSpace(configured))
            return configured.Trim().TrimEnd('/');
        if (!Uri.TryCreate(origin ?? "", UriKind.Absolute, out var o) || (o.Scheme != "http" && o.Scheme != "https"))
            return null;
        if (!IsThisMachine(o.Host))
            return null;
        return $"{o.Scheme}://127.0.0.1:{o.Port}";
    }

    private static bool IsThisMachine(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, Environment.MachineName, StringComparison.OrdinalIgnoreCase))
            return true;
        if (!IPAddress.TryParse(host.Trim('[', ']'), out var ip))
            return false;
        if (IPAddress.IsLoopback(ip))
            return true;
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Any(u => u.Address.Equals(ip));
        }
        catch
        {
            return false;
        }
    }

    private static LoginResult Issue(AuthStore auth, OrgView view, OrgUser user, Project project, bool remember) => new(
        auth.IssueSession(user.Id, project.Id),
        user,
        project,
        OrgStore.PermsOf(view, user, project.Id),
        remember ? auth.IssueRemember(user.Id, project.Id) : null);

    private static (OrgView View, OrgUser? User, Project? Project) Current(HttpContext context, OrgStore store, AuthStore auth)
    {
        var view = store.Load();
        var session = auth.GetSession(context);
        if (session is null)
            return (view, null, null);
        return (view, view.Users.FirstOrDefault(u => u.Id == session.UserId), view.Projects.FirstOrDefault(p => p.Id == session.ProjectId));
    }

    private static IResult? CheckAdminPassword(AuthStore auth, string projectId, string? password)
    {
        try
        {
            return auth.VerifyAdmin(projectId, password) ? null : Error(403, "관리자 비밀번호가 올바르지 않습니다.");
        }
        catch (InvalidOperationException ex)
        {
            return Error(429, ex.Message);
        }
    }

    private static IResult Error(int status, string message) => Results.Json(new { error = message }, statusCode: status);

    private static async Task<IResult> Run(IHubContext<DashboardHub, IDashboardClient> hub, Func<OrgView> action)
    {
        OrgView view;
        try
        {
            view = action();
        }
        catch (ArgumentException ex)
        {
            return Error(400, ex.Message);
        }
        catch (KeyNotFoundException ex)
        {
            return Error(404, ex.Message);
        }
        await hub.Clients.All.OrgChanged(view);
        return Results.Ok(view);
    }
}
