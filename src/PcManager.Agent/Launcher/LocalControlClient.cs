using System.IO.Pipes;
using System.Text.Json;

namespace PcManager.Agent.Launcher;

/// <summary>런처에서 에이전트 서비스로 요청을 보낸다.</summary>
public static class LocalControlClient
{
    public const string ServiceUnavailableMessage = "에이전트 서비스가 실행 중이 아닙니다";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <returns>서비스에 닿지 못하면 Ok=false, Status=null</returns>
    public static async Task<LocalResponse> SendAsync(LocalRequest request, TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        try
        {
            await using var pipe = new NamedPipeClientStream(".", LocalControl.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(cancel.Token);

            using var reader = new StreamReader(pipe, leaveOpen: true);
            await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
            await writer.WriteLineAsync(JsonSerializer.Serialize(request, Json));

            var line = await reader.ReadLineAsync(cancel.Token);
            return (line is null ? null : JsonSerializer.Deserialize<LocalResponse>(line, Json))
                ?? new LocalResponse(false, "에이전트 서비스 응답이 없습니다", null);
        }
        catch (OperationCanceledException)
        {
            return new LocalResponse(false, ServiceUnavailableMessage, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or TimeoutException)
        {
            return new LocalResponse(false, $"{ServiceUnavailableMessage} ({ex.Message})", null);
        }
    }
}
