using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>프로젝트·사용자·할당 관리</summary>
public static class OrgEndpoints
{
    public static void MapOrgApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/org", (OrgStore store) => Results.Ok(store.Load()));

        api.MapPost("/projects", (NameRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.AddProject(req.Name ?? "")));

        api.MapPut("/projects/{id}", (string id, NameRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.RenameProject(id, req.Name ?? "")));

        api.MapDelete("/projects/{id}", (string id, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.DeleteProject(id)));

        api.MapPut("/projects/{id}/users", (string id, AssignProjectUsersRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.SetProjectUsers(id, req.UserIds ?? [])));

        api.MapPost("/users", (NameRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.AddUser(req.Name ?? "")));

        api.MapDelete("/users/{id}", (string id, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.DeleteUser(id)));

        api.MapPut("/agents/{agentId}/project", (string agentId, AssignAgentProjectRequest req, OrgStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            Run(hub, () => store.SetAgentProject(agentId, req.ProjectId)));
    }

    private static async Task<IResult> Run(IHubContext<DashboardHub, IDashboardClient> hub, Func<OrgView> action)
    {
        OrgView view;
        try
        {
            view = action();
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(ex.Message);
        }
        await hub.Clients.All.OrgChanged(view);
        return Results.Ok(view);
    }
}
