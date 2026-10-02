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
            return isApi || !File.Exists(indexPath) ? Results.NotFound() : Results.File(indexPath, "text/html; charset=utf-8");
        });
    }
}
