namespace PcManager.Server.Api;

/// <summary>대시보드 화면 경로는 index.html로 돌려준다. 없는 API/Hub 경로는 404</summary>
public static class SpaFallbackEndpoints
{
    public static void MapSpaFallback(this WebApplication app)
    {
        app.MapFallback("{*path:nonfile}", (HttpContext context, IWebHostEnvironment env) =>
        {
            var indexPath = Path.Combine(env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot"), "index.html");
            var isApi = context.Request.Path.StartsWithSegments("/api") || context.Request.Path.StartsWithSegments("/hubs");
            if (isApi || !File.Exists(indexPath))
                return Results.NotFound();
            // 업데이트 후 옛 대시보드가 남지 않게 매번 서버에 확인
            context.Response.Headers.CacheControl = "no-cache";
            return Results.File(indexPath, "text/html; charset=utf-8");
        });
    }
}
