using System.Text.Json;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>명령 출력을 실행별 JSONL 파일로 저장한다.</summary>
public class RunLogStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task AppendAsync(string runId, IEnumerable<CommandOutput> lines)
    {
        var path = GetPath(runId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        await using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
        await using var writer = new StreamWriter(stream);
        foreach (var line in lines)
            await writer.WriteLineAsync(JsonSerializer.Serialize(line, Json));
    }

    /// <summary>afterSeq 이후의 출력을 읽는다. 재전송으로 생긴 중복 줄은 제거한다.</summary>
    public async Task<List<CommandOutput>> ReadAsync(string runId, long afterSeq)
    {
        var result = new List<CommandOutput>();
        var path = GetPath(runId);
        if (!File.Exists(path))
            return result;

        var seen = new HashSet<long>();
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync() is { } json)
        {
            CommandOutput? line;
            try
            {
                line = JsonSerializer.Deserialize<CommandOutput>(json, Json);
            }
            catch (JsonException)
            {
                break; // 기록 중인 마지막 줄
            }

            if (line is not null && line.Seq > afterSeq && seen.Add(line.Seq))
                result.Add(line);
        }
        return result;
    }

    private string GetPath(string runId)
    {
        // runId는 서버가 발급한 GUID만 허용 (경로 조작 방지)
        if (!Guid.TryParseExact(runId, "N", out _))
            throw new ArgumentException("잘못된 runId 형식입니다.", nameof(runId));
        return Path.Combine(paths.RunsDirectory, runId, "output.jsonl");
    }
}
