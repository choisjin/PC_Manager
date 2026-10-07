using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>
/// PC PIN 잠금 API와 강제 미들웨어.
/// 잠긴 PC의 /api/agents/{agentId}/... (파일·텍스트·영상·원격조작 등)는 잠금 해제 쿠키가 없으면 423으로 거절한다.
/// 상태 표시·프로젝트 지정처럼 PC 내용을 보지 않는 경로는 그대로 둔다.
/// </summary>
public static class PcLockEndpoints
{
    // PC 내용에 닿지 않는 경로 (/api/agents/{agentId} 뒤)
    private static readonly string[] OpenSuffixes = ["/status", "/project"];

    public static void UsePcLocks(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (context.Request.RouteValues.TryGetValue("agentId", out var value) && value is string agentId
                && context.Request.Path.StartsWithSegments("/api/agents", out var rest)
                && !OpenSuffixes.Any(s => rest.Value?.EndsWith(s, StringComparison.OrdinalIgnoreCase) == true))
            {
                var locks = context.RequestServices.GetRequiredService<PcLockStore>();
                if (!locks.CanAccess(context, agentId))
                {
                    await WriteLockedAsync(context, agentId);
                    return;
                }
            }
            await next();
        });
    }

    /// <summary>요청 본문에 PC id가 있는 API(PC 간 복사 등)에서 직접 확인</summary>
    public static IResult? Check(HttpContext context, PcLockStore locks, params string?[] agentIds)
    {
        foreach (var id in agentIds)
        {
            if (!string.IsNullOrEmpty(id) && !locks.CanAccess(context, id))
                return Results.Json(new PcLockedView(LockedMessage, id), statusCode: StatusCodes.Status423Locked);
        }
        return null;
    }

    private const string LockedMessage = "PIN으로 잠긴 PC입니다. PIN을 입력해야 쓸 수 있습니다.";

    private static Task WriteLockedAsync(HttpContext context, string agentId)
    {
        context.Response.StatusCode = StatusCodes.Status423Locked;
        return context.Response.WriteAsJsonAsync(new PcLockedView(LockedMessage, agentId));
    }

    public static void MapPcLockApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/pc-locks");

        // 잠긴 PC 목록 + 이 브라우저가 풀었는지
        api.MapGet("/", (HttpContext context, PcLockStore locks) =>
            locks.All().Select(l => new PcLockView(l.AgentId, l.OwnerUserId, l.LockedAt, locks.CanAccess(context, l.AgentId))));

        // 잠그기 (PIN 정하기). 건 브라우저는 바로 풀린 상태로
        api.MapPost("/{agentId}", async (string agentId, PinRequest request, HttpContext context, PcLockStore locks, ThumbnailService thumbnails, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(async () =>
            {
                var user = context.Request.Headers["X-User-Id"].ToString();
                locks.SetLock(agentId, request.Pin ?? "", string.IsNullOrEmpty(user) ? null : user);
                SetCookie(context, agentId, locks.Unlock(agentId, request.Pin ?? ""));
                thumbnails.Locked(agentId);
                await hub.Clients.All.PcLocksChanged();
                return Results.NoContent();
            }));

        api.MapPost("/{agentId}/unlock", (string agentId, PinRequest request, HttpContext context, PcLockStore locks) =>
            RunAsync(() =>
            {
                SetCookie(context, agentId, locks.Unlock(agentId, request.Pin ?? ""));
                return Task.FromResult(Results.NoContent());
            }));

        // 이 브라우저에서만 다시 잠그기
        api.MapPost("/{agentId}/relock", (string agentId, HttpContext context) =>
        {
            context.Response.Cookies.Delete(PcLockStore.CookiePrefix + agentId, new CookieOptions { Path = "/" });
            return Results.NoContent();
        });

        api.MapPut("/{agentId}/pin", async (string agentId, ChangePinRequest request, HttpContext context, PcLockStore locks, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(async () =>
            {
                locks.ChangePin(agentId, request.Pin ?? "", request.NewPin ?? "");
                // 바꾼 브라우저는 새 PIN으로 계속 풀린 상태, 다른 곳은 다시 PIN을 넣어야 한다
                SetCookie(context, agentId, locks.Unlock(agentId, request.NewPin ?? ""));
                await hub.Clients.All.PcLocksChanged();
                return Results.NoContent();
            }));

        // 잠금 없애기
        api.MapPost("/{agentId}/remove", async (string agentId, PinRequest request, HttpContext context, PcLockStore locks, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(async () =>
            {
                locks.RemoveLock(agentId, request.Pin ?? "");
                context.Response.Cookies.Delete(PcLockStore.CookiePrefix + agentId, new CookieOptions { Path = "/" });
                await hub.Clients.All.PcLocksChanged();
                return Results.NoContent();
            }));
    }

    private static void SetCookie(HttpContext context, string agentId, string value) =>
        context.Response.Cookies.Append(PcLockStore.CookiePrefix + agentId, value, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = context.Request.IsHttps,
            Path = "/",
            MaxAge = PcLockStore.UnlockLifetime,
        });

    private static async Task<IResult> RunAsync(Func<Task<IResult>> work)
    {
        try
        {
            return await work();
        }
        catch (UnauthorizedAccessException ex)
        {
            return Results.BadRequest(ex.Message);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or KeyNotFoundException)
        {
            return Results.BadRequest(ex.Message);
        }
    }
}
