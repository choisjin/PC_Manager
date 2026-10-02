using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using Timer = System.Threading.Timer;
using PcManager.Agent.Service;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 대시보드를 연 PC(편집 PC)에서 다른 PC의 파일을 이 PC 프로그램(엑셀 등)으로 연다.
/// 서버가 보내 준 파일을 '문서\PC Manager 편집\PC이름'에 두고 사용자 권한으로 기본 프로그램을 실행한 뒤,
/// 저장(파일 변경)을 감시해 원래 PC의 원래 경로로 되돌려 보낸다.
/// </summary>
public class LocalEditService(FileTransferService files, AgentSettingsStore settings, ILogger<LocalEditService> logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };

    /// <summary>열어 둔 파일을 이만큼 감시한다 (그 뒤 저장은 원래 PC로 가지 않음)</summary>
    private static readonly TimeSpan WatchLifetime = TimeSpan.FromHours(12);

    private ILogger Logger => logger;

    // 로컬 파일 경로 → 감시
    private readonly ConcurrentDictionary<string, EditWatch> _watches = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>편집 폴더에 받을 준비. 반환한 writeId로 서버가 WriteChunk 한다.</summary>
    public string Prepare(string folderLabel, string fileName)
    {
        var folder = Path.Combine(EditRoot(), Clean(folderLabel));
        Directory.CreateDirectory(folder);
        return files.BeginWrite(folder, Clean(fileName) + ".pcm-edit");
    }

    /// <summary>받은 파일을 확정하고 기본 프로그램으로 연다. 되돌려 저장할 수 있으면 감시를 시작한다.</summary>
    public async Task<string?> OpenAsync(OpenEditRequest request)
    {
        try
        {
            var temp = await files.FinishWriteToTempAsync(request.WriteId);
            var folder = Path.GetDirectoryName(temp)!;
            var name = Clean(Path.GetFileName(request.SourcePath.TrimEnd('\\', '/')));
            var target = Path.Combine(folder, name);

            // 같은 파일을 이미 열어 두었으면(프로그램이 잠금) 다른 이름으로 받는다
            if (_watches.TryRemove(target, out var old))
                old.Dispose();
            if (!TryReplace(temp, target))
            {
                target = UniquePath(folder, name);
                File.Move(temp, target);
            }
            // 읽기 전용(압축 안 파일 등)은 실수로 고치지 않게 속성을 건다
            if (request.ReadOnly)
                File.SetAttributes(target, File.GetAttributes(target) | FileAttributes.ReadOnly);

            Launch(target);
            if (!request.ReadOnly)
            {
                var watch = new EditWatch(this, target, request.SourceAgentId, request.SourcePath, request.BaseHash);
                _watches[target] = watch;
            }
            logger.LogInformation("편집 열기: {Source} → {Local}{ReadOnly}", request.SourcePath, target, request.ReadOnly ? " (읽기 전용)" : "");
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            logger.LogWarning("편집 열기 실패: {Message}", ex.Message);
            return ex.Message;
        }
    }

    /// <summary>이 PC의 파일을 그 자리에서 기본 프로그램으로 연다 (대시보드를 연 PC 자신의 파일).</summary>
    public string? LaunchInPlace(string path)
    {
        try
        {
            if (!File.Exists(path))
                return "파일이 없습니다.";
            Launch(path);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            return ex.Message;
        }
    }

    /// <summary>로그인한 사용자 권한으로 기본 프로그램 실행 (서비스는 SYSTEM이라 그대로 띄우면 사용자 화면에 안 보임)</summary>
    private static void Launch(string path)
    {
        // 개발·자동 테스트용: 실제 프로그램을 띄우지 않는다
        if (Environment.GetEnvironmentVariable("PCM_EDIT_NO_LAUNCH") == "1")
            return;
        if (AgentHost.IsRunningAsService)
        {
            var session = SessionProcess.GetInteractiveUserSessionId()
                ?? throw new InvalidOperationException("로그인한 사용자가 없어 프로그램을 열 수 없습니다.");
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            SessionProcess.StartAsSessionUser(session, explorer, $"\"{path}\"");
        }
        else
        {
            using var _ = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
    }

    /// <summary>'문서\PC Manager 편집'</summary>
    private static string EditRoot()
    {
        string documents;
        if (AgentHost.IsRunningAsService)
        {
            var session = SessionProcess.GetInteractiveUserSessionId()
                ?? throw new InvalidOperationException("로그인한 사용자가 없어 파일을 열 수 없습니다.");
            documents = SessionProcess.GetUserDocumentsFolder(session);
        }
        else
        {
            documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        }
        return Path.Combine(documents, "PC Manager 편집");
    }

    private static bool TryReplace(string temp, string target)
    {
        try
        {
            if (File.Exists(target))
                File.SetAttributes(target, FileAttributes.Normal);
            File.Move(temp, target, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string UniquePath(string folder, string name)
    {
        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 2; ; i++)
        {
            var candidate = Path.Combine(folder, $"{stem} ({i}){ext}");
            if (!File.Exists(candidate))
                return candidate;
        }
    }

    private static string Clean(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        return cleaned.Length == 0 ? "파일" : cleaned;
    }

    /// <summary>저장된 내용을 원래 PC로 보낸다.</summary>
    private async Task<EditSaveResult> UploadAsync(EditWatch watch, byte[] content)
    {
        var current = settings.Current;
        var query = $"?source={Uri.EscapeDataString(watch.SourceAgentId)}&path={Uri.EscapeDataString(watch.SourcePath)}&baseHash={Uri.EscapeDataString(watch.BaseHash)}";
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(current.ServerUrl), AgentTransferPaths.EditSave + query));
        if (!string.IsNullOrEmpty(current.Token))
            request.Headers.Add(AgentHeaders.Token, current.Token);
        request.Content = new ByteArrayContent(content);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode)
            return new EditSaveResult(false, $"서버 응답 {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}", null, null, false);
        return await response.Content.ReadFromJsonAsync<EditSaveResult>() ?? new EditSaveResult(false, "빈 응답", null, null, false);
    }

    /// <summary>편집 중인 파일 하나의 저장 감시</summary>
    private sealed class EditWatch : IDisposable
    {
        private readonly LocalEditService _owner;
        private readonly string _localPath;
        private readonly FileSystemWatcher _watcher;
        private readonly Timer _debounce;
        private readonly Timer _expire;
        private readonly SemaphoreSlim _uploadLock = new(1, 1);
        private string _lastHash;

        public EditWatch(LocalEditService owner, string localPath, string sourceAgentId, string sourcePath, string baseHash)
        {
            _owner = owner;
            _localPath = localPath;
            SourceAgentId = sourceAgentId;
            SourcePath = sourcePath;
            BaseHash = baseHash;
            _lastHash = baseHash;
            _debounce = new Timer(_ => _ = SaveAsync(), null, Timeout.Infinite, Timeout.Infinite);
            _expire = new Timer(_ => Expire(), null, WatchLifetime, Timeout.InfiniteTimeSpan);
            // 프로그램은 보통 임시 파일에 쓰고 이름을 바꿔 저장하므로 이름 바뀜·생성도 본다
            _watcher = new FileSystemWatcher(Path.GetDirectoryName(localPath)!, Path.GetFileName(localPath))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.CreationTime,
            };
            _watcher.Changed += (_, _) => Poke();
            _watcher.Created += (_, _) => Poke();
            _watcher.Renamed += (_, e) =>
            {
                if (string.Equals(e.FullPath, _localPath, StringComparison.OrdinalIgnoreCase))
                    Poke();
            };
            _watcher.EnableRaisingEvents = true;
        }

        public string SourceAgentId { get; }
        public string SourcePath { get; private set; }
        public string BaseHash { get; private set; }

        // 저장이 끝날 때까지(여러 번 쓰기) 잠깐 기다렸다 보낸다
        private void Poke() => _debounce.Change(1500, Timeout.Infinite);

        private async Task SaveAsync()
        {
            if (!await _uploadLock.WaitAsync(0))
            {
                Poke();
                return;
            }
            try
            {
                var content = await ReadWhenReadyAsync();
                if (content is null)
                    return;
                var hash = Convert.ToHexString(SHA256.HashData(content));
                if (hash == _lastHash)
                    return;

                var result = await _owner.UploadAsync(this, content);
                if (!result.Success)
                {
                    _owner.Logger.LogWarning("편집 저장을 원래 PC로 보내지 못했습니다 {Path}: {Error}", SourcePath, result.Error);
                    return; // 다음 저장 때 다시 시도
                }
                _lastHash = hash;
                BaseHash = result.Hash ?? hash;
                if (result.Conflict && result.SavedPath is not null)
                {
                    // 그 사이 원래 파일이 바뀌어 옆에 새 이름으로 저장했다 → 이후 저장도 그 파일로
                    SourcePath = result.SavedPath;
                }
                _owner.Logger.LogInformation("편집 저장 → {Source}{Conflict}", result.SavedPath, result.Conflict ? " (충돌: 새 이름)" : "");
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException or TaskCanceledException or UnauthorizedAccessException)
            {
                _owner.Logger.LogWarning("편집 저장 실패 {Path}: {Message}", _localPath, ex.Message);
            }
            finally
            {
                _uploadLock.Release();
            }
        }

        /// <summary>프로그램이 쓰는 중이면 잠깐 기다렸다 읽는다 (엑셀은 연 파일을 잠그지만 읽기는 허용)</summary>
        private async Task<byte[]?> ReadWhenReadyAsync()
        {
            for (var i = 0; i < 20; i++)
            {
                try
                {
                    if (!File.Exists(_localPath))
                        return null;
                    await using var stream = new FileStream(_localPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var memory = new MemoryStream();
                    await stream.CopyToAsync(memory);
                    return memory.ToArray();
                }
                catch (IOException)
                {
                    await Task.Delay(500);
                }
            }
            return null;
        }

        private void Expire()
        {
            if (_owner._watches.TryRemove(_localPath, out _))
                Dispose();
        }

        public void Dispose()
        {
            _watcher.Dispose();
            _debounce.Dispose();
            _expire.Dispose();
        }
    }
}
