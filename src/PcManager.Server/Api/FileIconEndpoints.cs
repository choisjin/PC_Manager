using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 탐색기 파일 아이콘: 윈도우에 설치된 확장자별 셸 아이콘을 PNG로 준다 (아이콘 파일은 배포하지 않음).
/// agent가 있으면 그 PC(대시보드를 연 PC)의 아이콘, 없거나 실패하면 서버 PC의 아이콘.
/// </summary>
public static class FileIconEndpoints
{
    // (PC, 확장자, 크기) → PNG. 실패도 기억해 반복 요청을 막는다
    private static readonly ConcurrentDictionary<string, Lazy<Task<byte[]?>>> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static void MapFileIconApi(this WebApplication app)
    {
        app.MapGet("/api/file-icon", async (string? ext, int? size, string? agent, AgentRegistry registry, IHubContext<AgentHub> agentHub, HttpContext http) =>
        {
            var extension = (ext ?? "").Trim().TrimStart('.');
            if (extension.Length == 0 || extension.Length > 16)
                return Results.BadRequest();
            var px = Math.Clamp(size ?? 32, 16, 256);

            byte[]? png = null;
            if (!string.IsNullOrEmpty(agent) && registry.TryGetConnection(agent, out var conn))
            {
                // 에이전트가 사용자 기준으로 꺼내고 기억한다 (서버는 따로 기억하지 않음: 로그인 전 임시 결과가 굳지 않게)
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
                    png = await agentHub.Clients.Client(conn).InvokeAsync<byte[]?>(AgentClientMethods.GetFileIcon, extension, px, timeout.Token);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    png = null; // 옛 에이전트 등 → 서버 아이콘
                }
            }
            if (png is null && OperatingSystem.IsWindows())
                png = await Cache.GetOrAdd($"server|{extension}|{px}", _ => new Lazy<Task<byte[]?>>(() => Task.Run(() => OperatingSystem.IsWindows() ? ShellIcons.GetPng(extension, px) : null))).Value;
            if (png is null)
                return Results.NotFound();

            http.Response.Headers.CacheControl = "public, max-age=86400";
            return Results.File(png, "image/png");
        });
    }
}
