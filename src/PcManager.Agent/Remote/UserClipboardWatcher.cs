using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using PcManager.Agent.Service;

namespace PcManager.Agent.Remote;

/// <summary>
/// 원격 PC 클립보드를 로그인한 사용자 권한으로 지켜본다.
/// 원격조작 프로세스는 SYSTEM이라 탐색기에서 복사한 파일 목록(OLE 지연 렌더링)을 못 보거나 못 꺼내는 경우가 있어,
/// 사용자 세션에 도우미(--watch-clipboard)를 띄워 두고 클립보드가 바뀔 때마다 그 쪽에서 읽은 내용(파일 목록·글)을
/// 사용자 임시 폴더의 파일(JSON 한 줄씩)로 받는다. 도우미는 이 프로세스가 끝나거나 그 파일이 지워지면 스스로 끝난다.
/// 도우미를 못 띄우면(로그인 전 등) 원격조작 프로세스가 직접 읽는다
/// </summary>
internal sealed class UserClipboardWatcher : IDisposable
{
    public const string HelperArgument = "--watch-clipboard";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan HelloTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan GoneTimeout = TimeSpan.FromSeconds(5);
    // 도우미는 PingInterval마다 살아 있다고 쓰고, 그 세 배 동안 아무 줄도 없으면 끝난 것으로 본다
    private static readonly TimeSpan PingInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan SilenceTimeout = TimeSpan.FromSeconds(15);
    private const int MaxTextLength = 256 * 1024;
    private const string FilePrefix = "PcManagerClipWatch-";

    /// <summary>클립보드 내용. first: 도우미가 떴을 때 이미 있던 내용 (새로 복사한 것이 아님)</summary>
    public sealed record Change(bool First, IReadOnlyList<string>? Files, string? Text);

    private readonly string _file;
    private readonly Action<Change> _onChange;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _cts = new();
    private volatile bool _active;

    /// <summary>도우미가 떠서 내용을 보내고 있는지 (아니면 원격조작 프로세스가 직접 읽어야 한다)</summary>
    public bool Active => _active;

    private UserClipboardWatcher(string file, Action<Change> onChange, Action<string> log)
    {
        _file = file;
        _onChange = onChange;
        _log = log;
    }

    /// <summary>도우미를 띄운다. 로그인한 사용자가 없거나 못 띄우면 null</summary>
    public static UserClipboardWatcher? Start(Action<Change> onChange, Action<string> log)
    {
        try
        {
            var exe = Environment.ProcessPath!;
            string file;
            if (WindowsIdentity.GetCurrent().IsSystem)
            {
                // 결과 파일: 사용자가 쓸 수 있는 그 사용자의 임시 폴더 (SYSTEM은 읽을 수 있다)
                var session = Process.GetCurrentProcess().SessionId;
                var folder = Path.Combine(SessionProcess.GetUserLocalAppDataFolder(session), "Temp");
                Directory.CreateDirectory(folder);
                CleanupStale(folder);
                file = Path.Combine(folder, $"{FilePrefix}{Guid.NewGuid():N}.jsonl");
                SessionProcess.StartAsSessionUser(session, exe, $"{HelperArgument} \"{file}\" {Environment.ProcessId}");
            }
            else
            {
                // 개발용 콘솔 모드: 원격조작 프로세스도 사용자라 바로 띄운다
                file = Path.Combine(Path.GetTempPath(), $"{FilePrefix}{Guid.NewGuid():N}.jsonl");
                var start = new ProcessStartInfo(exe) { UseShellExecute = false };
                start.ArgumentList.Add(HelperArgument);
                start.ArgumentList.Add(file);
                start.ArgumentList.Add(Environment.ProcessId.ToString());
                Process.Start(start)?.Dispose();
            }
            var watcher = new UserClipboardWatcher(file, onChange, log);
            _ = Task.Run(watcher.ReadLoopAsync);
            return watcher;
        }
        catch (Exception ex) when (ex is Win32Exception or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log($"사용자 권한 클립보드 감시 도우미를 띄우지 못함 → 직접 읽기: {ex.Message}");
            return null;
        }
    }

    /// <summary>지난 감시가 비정상 종료로 남긴 파일 정리 (하루 넘은 것)</summary>
    private static void CleanupStale(string folder)
    {
        try
        {
            foreach (var old in Directory.EnumerateFiles(folder, FilePrefix + "*.jsonl"))
            {
                if (DateTime.UtcNow - File.GetLastWriteTimeUtc(old) > TimeSpan.FromDays(1))
                    File.Delete(old);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 남아도 무방
        }
    }

    /// <summary>도우미가 쓰는 파일을 따라 읽는다 (새 줄이 생길 때마다). 도우미가 안 뜨거나 끝나면 멈춘다</summary>
    private async Task ReadLoopAsync()
    {
        var ct = _cts.Token;
        var started = Stopwatch.StartNew();
        var lastLine = Stopwatch.StartNew();
        Stopwatch? gone = null;
        long offset = 0;
        // 아직 줄이 끝나지 않은 조각
        var pending = new MemoryStream();
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(250, ct);
                byte[] chunk;
                try
                {
                    using var stream = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    gone = null;
                    var length = stream.Length;
                    if (length <= offset)
                    {
                        if (!_active && started.Elapsed > HelloTimeout)
                            break;
                        if (_active && lastLine.Elapsed > SilenceTimeout)
                        {
                            _active = false;
                            _log("사용자 권한 클립보드 감시 도우미가 응답이 없음 → 직접 읽기");
                            break;
                        }
                        continue;
                    }
                    stream.Position = offset;
                    chunk = new byte[length - offset];
                    stream.ReadExactly(chunk);
                    offset = length;
                    lastLine.Restart();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // 도우미가 아직 파일을 안 만들었거나(시작 중), 끝나서 지워짐
                    if (!_active)
                    {
                        if (started.Elapsed > HelloTimeout)
                        {
                            _log($"사용자 권한 클립보드 감시 도우미가 응답하지 않음 → 직접 읽기 ({ex.Message})");
                            break;
                        }
                        continue;
                    }
                    gone ??= Stopwatch.StartNew();
                    if (gone.Elapsed > GoneTimeout)
                    {
                        _active = false;
                        _log("사용자 권한 클립보드 감시 도우미가 끝남 → 직접 읽기");
                        break;
                    }
                    continue;
                }

                pending.Write(chunk);
                var all = pending.ToArray();
                pending.SetLength(0);
                var from = 0;
                for (var i = 0; i < all.Length; i++)
                {
                    if (all[i] != (byte)'\n')
                        continue;
                    HandleLine(Encoding.UTF8.GetString(all, from, i - from).TrimEnd('\r'));
                    from = i + 1;
                }
                if (from < all.Length)
                    pending.Write(all, from, all.Length - from);
            }
        }
        catch (OperationCanceledException)
        {
            // 종료
        }
    }

    private void HandleLine(string line)
    {
        if (line.Length == 0)
            return;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.TryGetProperty("hello", out _))
            {
                _active = true;
                _log("사용자 권한 클립보드 감시 시작");
                return;
            }
            if (root.TryGetProperty("ping", out _))
                return;
            var first = root.TryGetProperty("first", out var f) && f.ValueKind == JsonValueKind.True;
            List<string>? files = null;
            if (root.TryGetProperty("files", out var list) && list.ValueKind == JsonValueKind.Array)
                files = list.EnumerateArray().Select(e => e.GetString() ?? "").Where(p => p.Length > 0).ToList();
            var text = root.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            _onChange(new Change(first, files, text));
        }
        catch (JsonException)
        {
            // 잘린 줄 등은 무시
        }
    }

    public void Dispose()
    {
        // 읽기 작업이 토큰을 보고 끝나도록 취소만 한다 (프로세스가 곧 끝나므로 Dispose는 생략)
        _cts.Cancel();
        // 파일을 지우면 도우미도 끝난다
        try
        {
            File.Delete(_file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 도우미가 부모 종료를 보고 끝낸다
        }
    }

    // ── 도우미 본체 (사용자 세션에서 실행)

    /// <summary>
    /// 클립보드가 바뀔 때마다 파일 목록·글을 outputFile에 JSON 한 줄씩 쓴다.
    /// 부모(원격조작 프로세스)가 끝나거나 outputFile이 지워지면 끝난다
    /// </summary>
    public static int RunHelper(string outputFile, int parentPid)
    {
        try
        {
            using var stream = new FileStream(outputFile, FileMode.Create, FileAccess.Write, FileShare.Read | FileShare.Delete);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
            writer.WriteLine("""{"hello":true}""");
            var last = 0u;
            var first = true;
            var check = Stopwatch.StartNew();
            var ping = Stopwatch.StartNew();
            while (true)
            {
                Thread.Sleep(250);
                if (check.ElapsedMilliseconds >= 1000)
                {
                    check.Restart();
                    if (!IsRunning(parentPid) || !File.Exists(outputFile))
                        return 0;
                }
                // 살아 있다는 표시 (부모가 도우미 종료를 알아채게)
                if (ping.Elapsed >= PingInterval)
                {
                    ping.Restart();
                    writer.WriteLine("""{"ping":true}""");
                }

                var sequence = RemoteClipboard.SequenceNumber;
                if (!first && sequence == last)
                    continue;
                IReadOnlyList<string>? files;
                string? text;
                try
                {
                    files = RemoteClipboard.GetFiles();
                    text = files is { Count: > 0 } ? null : RemoteClipboard.GetText();
                }
                catch (ClipboardBusyException)
                {
                    // 복사한 앱이 아직 쓰는 중 → 다음에 다시 (이번 변경을 본 것으로 치지 않는다)
                    continue;
                }
                last = sequence;
                if (text is { Length: > MaxTextLength })
                    text = null;
                writer.WriteLine(JsonSerializer.Serialize(new { seq = sequence, first, files, text }, Json));
                ping.Restart();
                first = false;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 1;
        }
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return true;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return false;
        }
    }
}
