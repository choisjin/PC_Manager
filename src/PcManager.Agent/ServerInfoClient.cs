using System.Text.Json;

namespace PcManager.Agent;

/// <summary>서버 주소 정규화와 서버 확인(/api/install/info)</summary>
public static class ServerInfoClient
{
    public const int DefaultPort = 5063;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };

    /// <summary>
    /// 사용자가 입력한 주소를 "http://호스트:포트" 형태로 만든다.
    /// 스킴이 없으면 http, 포트가 없으면 서버 기본 포트를 붙인다. 형식이 틀리면 null.
    /// </summary>
    public static string? NormalizeServerUrl(string? input)
    {
        var text = input?.Trim();
        if (string.IsNullOrEmpty(text))
            return null;
        // 스킴을 먼저 붙인 뒤 후행 슬래시를 지운다 (먼저 지우면 "http://"가 "http:"로 망가진다)
        if (!text.Contains("://", StringComparison.Ordinal))
            text = "http://" + text;
        text = text.TrimEnd('/');

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.IsNullOrEmpty(uri.Host))
        {
            return null;
        }

        var authority = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..].Split('/')[0];
        // "http://" 처럼 호스트가 비었거나, 사용자가 포트만 적은 경우를 거른다
        if (authority.Length == 0 || authority.StartsWith(':'))
            return null;
        var hasPort = authority.LastIndexOf(':') > authority.LastIndexOf(']');
        var builder = new UriBuilder(uri.Scheme, uri.Host, hasPort ? uri.Port : DefaultPort);
        return builder.Uri.GetLeftPart(UriPartial.Authority);
    }

    /// <returns>서버 버전 또는 연결 오류 메시지</returns>
    public static async Task<(string? Version, string? Error)> ProbeAsync(string serverUrl, CancellationToken ct)
    {
        try
        {
            using var response = await Http.GetAsync($"{serverUrl.TrimEnd('/')}/api/install/info", ct);
            if (!response.IsSuccessStatusCode)
                return (null, $"PC Manager 서버가 아닙니다 (HTTP {(int)response.StatusCode})");

            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var version = document.RootElement.TryGetProperty("serverVersion", out var value) ? value.GetString() : null;
            return (version, null);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return (null, "응답 시간이 초과되었습니다");
        }
        catch (HttpRequestException ex)
        {
            return (null, ex.Message);
        }
        catch (JsonException)
        {
            return (null, "PC Manager 서버가 아닙니다");
        }
    }
}
