using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Extensions.Options;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>서버가 요청한 명령을 실행하고 출력과 결과를 보고 큐에 넣는다.</summary>
public class CommandRunner(OutboundQueue outbound, IOptions<AgentOptions> options, ILogger<CommandRunner> logger)
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    // 결과가 서버에 전달될 때까지 추적한다. 재등록 시 서버가 이 명령들을 실패 처리하지 않게 한다.
    private readonly ConcurrentDictionary<string, byte> _unreported = new();

    public IReadOnlyList<string> UnreportedRunIds => [.. _unreported.Keys];

    public void Start(RunCommandRequest request)
    {
        if (!_unreported.TryAdd(request.RunId, 0))
            return; // 중복 요청

        var cancel = new CancellationTokenSource();
        _running[request.RunId] = cancel;
        _ = Task.Run(() => RunAsync(request, cancel));
    }

    public void Cancel(string runId)
    {
        if (_running.TryGetValue(runId, out var cancel))
        {
            try
            {
                cancel.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // 방금 종료됨
            }
            return;
        }

        // 에이전트가 모르는 명령이면 서버의 대기 상태를 정리할 수 있게 취소로 보고한다
        if (!_unreported.ContainsKey(runId))
        {
            outbound.Enqueue(new CommandCompleted(
                runId, RunState.Cancelled, null, "에이전트에서 실행 중인 명령이 아닙니다.", DateTime.UtcNow));
        }
    }

    /// <summary>CommandCompleted가 서버에 전달된 뒤 호출한다.</summary>
    public void MarkReported(string runId) => _unreported.TryRemove(runId, out _);

    private async Task RunAsync(RunCommandRequest request, CancellationTokenSource cancel)
    {
        var outputLock = new Lock();
        long seq = 0;

        // stdout/stderr 이벤트가 다른 스레드에서 오므로 번호 부여와 큐 삽입을 함께 잠근다
        void Emit(OutputStream stream, string text)
        {
            lock (outputLock)
                outbound.Enqueue(new CommandOutput(request.RunId, ++seq, stream, text, DateTime.UtcNow));
        }

        RunState state;
        int? exitCode = null;
        string? error = null;

        try
        {
            using var timeout = request.TimeoutSeconds > 0
                ? new CancellationTokenSource(TimeSpan.FromSeconds(request.TimeoutSeconds))
                : new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel.Token, timeout.Token);
            using var process = new Process { StartInfo = BuildStartInfo(request) };
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data is not null)
                    Emit(OutputStream.StdOut, e.Data);
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is not null)
                    Emit(OutputStream.StdErr, e.Data);
            };

            process.Start();
            outbound.Enqueue(new CommandStarted(request.RunId, process.Id, DateTime.UtcNow));
            logger.LogInformation("명령 시작 {RunId} (PID {Pid})", request.RunId, process.Id);

            try
            {
                // 입력 대기(pause 등)로 멈추지 않도록 바로 EOF를 보낸다
                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // 이미 종료된 프로세스
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            try
            {
                await process.WaitForExitAsync(linked.Token);
                exitCode = process.ExitCode;
                state = exitCode == 0 ? RunState.Succeeded : RunState.Failed;
            }
            catch (OperationCanceledException)
            {
                state = cancel.IsCancellationRequested ? RunState.Cancelled : RunState.TimedOut;
                Emit(OutputStream.System, state == RunState.Cancelled
                    ? "취소 요청으로 프로세스를 종료합니다."
                    : $"제한 시간({request.TimeoutSeconds}초)을 넘어 프로세스를 종료합니다.");
                KillTree(process);
            }
        }
        catch (Exception ex)
        {
            state = RunState.Failed;
            error = ex.Message;
            Emit(OutputStream.System, $"실행 실패: {ex.Message}");
            logger.LogWarning(ex, "명령 실행 실패 {RunId}", request.RunId);
        }

        _running.TryRemove(request.RunId, out _);
        cancel.Dispose();
        outbound.Enqueue(new CommandCompleted(request.RunId, state, exitCode, error, DateTime.UtcNow));
        logger.LogInformation("명령 종료 {RunId}: {State} (exit {ExitCode})", request.RunId, state, exitCode);
    }

    private ProcessStartInfo BuildStartInfo(RunCommandRequest request)
    {
        var workingDirectory = string.IsNullOrWhiteSpace(request.WorkingDirectory)
            ? Directory.CreateDirectory(Path.Combine(options.Value.DataDirectory, "work")).FullName
            : request.WorkingDirectory;
        var encoding = ResolveEncoding(request.Encoding);

        var startInfo = new ProcessStartInfo
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = encoding,
            StandardErrorEncoding = encoding,
            WorkingDirectory = workingDirectory,
        };

        // 테스트가 결과를 남길 폴더를 알려준다. 같은 Job의 단계들은 폴더를 공유한다
        var resultDirectory = Directory.CreateDirectory(
            options.Value.GetResultDirectory(request.JobRunId ?? request.RunId)).FullName;
        startInfo.Environment[AgentEnvironment.RunId] = request.RunId;
        startInfo.Environment[AgentEnvironment.ResultDir] = resultDirectory;
        if (request.JobRunId is not null)
            startInfo.Environment[AgentEnvironment.JobRunId] = request.JobRunId;

        switch (request.Shell)
        {
            case ShellKind.Cmd:
                startInfo.FileName = "cmd.exe";
                // /s: 바깥 따옴표만 벗기고 나머지는 그대로 해석
                startInfo.Arguments = $"/d /s /c \"{request.CommandLine}\"";
                break;

            case ShellKind.PowerShell:
                // 따옴표 이스케이프 문제를 피하려고 스크립트를 Base64(UTF-16LE)로 전달한다
                var script = "$ProgressPreference = 'SilentlyContinue'\n" + request.CommandLine;
                startInfo.FileName = "powershell.exe";
                startInfo.ArgumentList.Add("-NoProfile");
                startInfo.ArgumentList.Add("-NonInteractive");
                startInfo.ArgumentList.Add("-ExecutionPolicy");
                startInfo.ArgumentList.Add("Bypass");
                startInfo.ArgumentList.Add("-EncodedCommand");
                startInfo.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
                break;

            default:
                throw new NotSupportedException($"지원하지 않는 셸입니다: {request.Shell}");
        }

        return startInfo;
    }

    private void KillTree(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(TimeSpan.FromSeconds(10));
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            logger.LogWarning(ex, "프로세스 종료 실패");
        }
    }

    private static Encoding ResolveEncoding(string? name)
    {
        if (!string.IsNullOrWhiteSpace(name))
        {
            try
            {
                return Encoding.GetEncoding(name);
            }
            catch (ArgumentException)
            {
                // 알 수 없는 이름이면 시스템 기본값 사용
            }
        }

        // cmd, 콘솔 프로그램이 파이프로 출력할 때 쓰는 OEM 코드 페이지 (한국어 Windows는 949)
        return Encoding.GetEncoding((int)GetOEMCP());
    }

    [DllImport("kernel32.dll")]
    private static extern uint GetOEMCP();
}
