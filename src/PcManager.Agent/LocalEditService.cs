using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using PcManager.Agent.Service;
using PcManager.Shared;
using Timer = System.Threading.Timer;

namespace PcManager.Agent;

/// <summary>
/// 대시보드를 연 PC(편집 PC)에서 다른 PC의 파일을 이 PC 프로그램(엑셀 등)으로 연다.
/// 서버가 보내 준 파일을 '문서\PC Manager 편집\PC이름'에 두고 사용자 권한으로 기본 프로그램을 실행한 뒤,
/// 저장(파일 변경)을 감시해 원래 PC의 원래 경로로 되돌려 보낸다.
/// 받은 사본은 원래 PC로 다 보냈고 프로그램이 닫혔으면(잠금 없음, 10분간 변경 없음) 지운다.
/// 받은 사본 목록은 에이전트 데이터 폴더에 저장해 재시작 후에도 감시·정리를 이어 간다.
/// </summary>
public class LocalEditService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };

    /// <summary>열어 둔 파일을 이만큼 감시한다 (그 뒤 저장은 원래 PC로 가지 않음)</summary>
    private static readonly TimeSpan WatchLifetime = TimeSpan.FromHours(12);

    /// <summary>마지막 변경 후 이만큼 지나고 아무도 열고 있지 않으면 사본을 지운다</summary>
    private static readonly TimeSpan IdleBeforeDelete = TimeSpan.FromMinutes(10);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly FileTransferService _files;
    private readonly AgentSettingsStore _settings;
    private readonly ILogger<LocalEditService> _logger;
    private readonly string _manifestPath;
    private readonly Lock _lock = new();
    private readonly Timer _cleanup;

    // 로컬 사본 경로 → 받은 사본 (감시 포함)
    private readonly ConcurrentDictionary<string, ManagedCopy> _copies = new(StringComparer.OrdinalIgnoreCase);

    public LocalEditService(FileTransferService files, AgentSettingsStore settings, IOptions<AgentOptions> options, ILogger<LocalEditService> logger)
    {
        _files = files;
        _settings = settings;
        _logger = logger;
        _manifestPath = Path.Combine(options.Value.DataDirectory, "edit-copies.json");
        Restore();
        _cleanup = new Timer(_ => Cleanup(), null, TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(1));
    }

    /// <summary>편집 폴더에 받을 준비. 반환한 writeId로 서버가 WriteChunk 한다.</summary>
    public string Prepare(string folderLabel, string fileName)
    {
        var folder = Path.Combine(EditRoot(), Clean(folderLabel));
        Directory.CreateDirectory(folder);
        return _files.BeginWrite(folder, Clean(fileName) + ".pcm-edit");
    }

    /// <summary>받은 파일을 확정하고 기본 프로그램으로 연다. 되돌려 저장할 수 있으면 감시를 시작한다.</summary>
    public async Task<string?> OpenAsync(OpenEditRequest request)
    {
        try
        {
            var temp = await _files.FinishWriteToTempAsync(request.WriteId);
            var folder = Path.GetDirectoryName(temp)!;
            var name = Clean(Path.GetFileName(request.SourcePath.TrimEnd('\\', '/')));
            var target = Path.Combine(folder, name);

            // 같은 파일을 이미 열어 두었으면(프로그램이 잠금) 다른 이름으로 받는다
            if (!TryReplace(temp, target))
            {
                target = UniquePath(folder, name);
                File.Move(temp, target);
            }
            if (_copies.TryRemove(target, out var old))
                old.Dispose();
            // 읽기 전용(압축 안 파일 등)은 실수로 고치지 않게 속성을 건다
            if (request.ReadOnly)
                File.SetAttributes(target, File.GetAttributes(target) | FileAttributes.ReadOnly);

            var copy = new ManagedCopy(this, new CopyRecord
            {
                LocalPath = target,
                SourceAgentId = request.SourceAgentId,
                SourcePath = request.SourcePath,
                BaseHash = request.BaseHash,
                SyncedHash = request.BaseHash,
                Backup = request.Backup,
                ReadOnly = request.ReadOnly,
                OpenedAt = DateTime.UtcNow,
            });
            _copies[target] = copy;
            SaveManifest();

            Launch(target);
            _logger.LogInformation("편집 열기: {Source} → {Local}{ReadOnly}", request.SourcePath, target, request.ReadOnly ? " (읽기 전용)" : "");
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            _logger.LogWarning("편집 열기 실패: {Message}", ex.Message);
            return ex.Message;
        }
    }

    /// <summary>이 PC의 파일을 그 자리에서 기본 프로그램으로 연다 (대시보드를 연 PC 자신의 파일).</summary>
    public string? LaunchInPlace(string path)
    {
        try
        {
            if (!File.Exists(path) && !Directory.Exists(path))
                return "파일이 없습니다.";
            Launch(path);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            return ex.Message;
        }
    }

    /// <summary>편집 폴더 현황 (설정 페이지)</summary>
    public EditFolderInfo GetInfo()
    {
        string? root = null;
        try
        {
            root = EditRoot();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            // 로그인한 사용자가 없음
        }
        var existing = _copies.Values.Where(c => File.Exists(c.Record.LocalPath)).ToList();
        return new EditFolderInfo(
            root,
            existing.Count,
            existing.Sum(c => SafeLength(c.Record.LocalPath)),
            existing.Count(c => c.HasPendingChanges()));
    }

    /// <summary>편집 폴더를 탐색기로 연다 (없으면 만든다).</summary>
    public string? OpenFolder()
    {
        try
        {
            var root = EditRoot();
            Directory.CreateDirectory(root);
            Launch(root);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            return ex.Message;
        }
    }

    /// <summary>
    /// 지금 정리: 원래 PC로 다 보냈고 열려 있지 않은 받은 사본을 모두 지운다.
    /// 다른 프로그램이 열고 있거나 아직 못 보낸 변경이 있는 사본은 남긴다. 직접 저장한 다른 파일은 건드리지 않는다.
    /// </summary>
    public EditCleanResult CleanNow()
    {
        int deleted = 0, inUse = 0, pending = 0;
        long bytes = 0;
        foreach (var copy in _copies.Values.ToList())
        {
            var path = copy.Record.LocalPath;
            if (!File.Exists(path))
            {
                Forget(copy);
                continue;
            }
            if (copy.HasPendingChanges())
            {
                pending++;
                copy.Poke(); // 다시 보내 본다
                continue;
            }
            var size = SafeLength(path);
            if (!TryDelete(path))
            {
                inUse++;
                continue;
            }
            deleted++;
            bytes += size;
            // 지운 뒤 프로그램이 다시 저장하면(메모장 등) 되돌려 보내도록 감시는 만료 때까지 둔다
            if (copy.IsExpired)
                Forget(copy);
        }
        RemoveEmptyFolders();
        SaveManifest();
        return new EditCleanResult(deleted, bytes, inUse, pending, GetInfo());
    }

    /// <summary>1분마다: 다 보냈고 닫힌(잠금 없음·10분 변경 없음) 사본을 지우고, 못 보낸 변경은 다시 보낸다.</summary>
    private void Cleanup()
    {
        try
        {
            var changed = false;
            foreach (var copy in _copies.Values.ToList())
            {
                var record = copy.Record;
                var expired = copy.IsExpired;
                if (!File.Exists(record.LocalPath))
                {
                    // 지운 뒤에도 프로그램이 다시 저장하면(메모장 등) 되돌려 보내도록 감시는 만료 때까지 둔다
                    if (expired)
                    {
                        Forget(copy);
                        changed = true;
                    }
                    continue;
                }
                if (copy.HasPendingChanges())
                {
                    if (!expired)
                        copy.Poke();
                    continue; // 못 보낸 변경이 있으면 지우지 않는다
                }
                var idle = DateTime.UtcNow - File.GetLastWriteTimeUtc(record.LocalPath) > IdleBeforeDelete;
                if (idle && TryDelete(record.LocalPath))
                {
                    _logger.LogInformation("편집 사본 정리: {Local}", record.LocalPath);
                    if (expired)
                        Forget(copy);
                    changed = true;
                }
            }
            if (changed)
            {
                RemoveEmptyFolders();
                SaveManifest();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "편집 사본 정리 실패");
        }
    }

    private void Forget(ManagedCopy copy)
    {
        if (_copies.TryRemove(copy.Record.LocalPath, out var removed))
            removed.Dispose();
    }

    /// <summary>다른 프로그램이 열고 있지 않을 때만 지운다</summary>
    private static bool TryDelete(string path)
    {
        try
        {
            // 공유 없이 열리면 아무도 쓰고 있지 않은 것
            using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
            {
            }
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    // 편집 폴더 아래 빈 PC 폴더 정리 (편집 폴더 자체는 둔다)
    private void RemoveEmptyFolders()
    {
        // 감시 중인 사본이 있는 폴더는 둔다 (폴더를 지우면 저장 감시가 끊긴다)
        var watched = _copies.Values.Where(c => !c.IsExpired && !c.Record.ReadOnly)
            .Select(c => Path.GetDirectoryName(c.Record.LocalPath))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            var root = EditRoot();
            if (Directory.Exists(root))
                foreach (var dir in Directory.EnumerateDirectories(root).Where(d => !watched.Contains(d)))
                    TryRemoveEmpty(dir);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or IOException or UnauthorizedAccessException)
        {
            // 로그인한 사용자가 없음 등
        }
    }

    private static void TryRemoveEmpty(string? folder)
    {
        try
        {
            if (folder is not null && Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any())
                Directory.Delete(folder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
        }
    }

    private static long SafeLength(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    // ── 받은 사본 목록 저장/복원 ──

    private void SaveManifest()
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_manifestPath)!);
                var temp = _manifestPath + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(_copies.Values.Select(c => c.Record).ToList(), Json));
                File.Move(temp, _manifestPath, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning("편집 사본 목록 저장 실패: {Message}", ex.Message);
            }
        }
    }

    private void Restore()
    {
        try
        {
            if (!File.Exists(_manifestPath))
                return;
            var records = JsonSerializer.Deserialize<List<CopyRecord>>(File.ReadAllText(_manifestPath), Json) ?? [];
            foreach (var record in records)
            {
                var expired = DateTime.UtcNow - record.OpenedAt > WatchLifetime;
                // 만료됐고 사본도 없으면 버린다. 사본이 남아 있으면 정리 대상으로 계속 관리한다
                if (expired && !File.Exists(record.LocalPath))
                    continue;
                if (Directory.Exists(Path.GetDirectoryName(record.LocalPath)))
                    _copies[record.LocalPath] = new ManagedCopy(this, record);
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning("편집 사본 목록 복원 실패: {Message}", ex.Message);
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
    private async Task<EditSaveResult> UploadAsync(CopyRecord record, byte[] content)
    {
        var current = _settings.Current;
        var query = $"?source={Uri.EscapeDataString(record.SourceAgentId)}&path={Uri.EscapeDataString(record.SourcePath)}"
            + $"&baseHash={Uri.EscapeDataString(record.BaseHash)}&backup={(record.Backup ? 1 : 0)}";
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

    /// <summary>받은 사본 한 개의 기록 (재시작 후 복원용으로 저장)</summary>
    // JSON으로 저장·읽기: 난독화하면 생성자 매개변수 이름이 지워져 읽지 못하므로 제외
    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class CopyRecord
    {
        public required string LocalPath { get; init; }
        public required string SourceAgentId { get; init; }
        public required string SourcePath { get; set; }
        /// <summary>원래 PC 파일의 마지막으로 알고 있는 내용 해시 (충돌 확인용)</summary>
        public required string BaseHash { get; set; }
        /// <summary>원래 PC로 마지막으로 보낸(또는 받은) 내용 해시. 사본이 이와 다르면 아직 못 보낸 변경이 있다</summary>
        public required string SyncedHash { get; set; }
        public bool Backup { get; init; }
        public bool ReadOnly { get; init; }
        public DateTime OpenedAt { get; init; }
    }

    /// <summary>받은 사본 + 저장 감시</summary>
    private sealed class ManagedCopy : IDisposable
    {
        private readonly LocalEditService _owner;
        private readonly FileSystemWatcher? _watcher;
        private readonly Timer _debounce;
        private readonly SemaphoreSlim _uploadLock = new(1, 1);

        public ManagedCopy(LocalEditService owner, CopyRecord record)
        {
            _owner = owner;
            Record = record;
            _debounce = new Timer(_ => _ = SaveAsync(), null, Timeout.Infinite, Timeout.Infinite);
            if (record.ReadOnly || DateTime.UtcNow - record.OpenedAt > WatchLifetime)
                return;
            // 프로그램은 보통 임시 파일에 쓰고 이름을 바꿔 저장하므로 이름 바뀜·생성도 본다
            _watcher = new FileSystemWatcher(Path.GetDirectoryName(record.LocalPath)!, Path.GetFileName(record.LocalPath))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.CreationTime,
            };
            _watcher.Changed += (_, _) => Poke();
            _watcher.Created += (_, _) => Poke();
            _watcher.Renamed += (_, e) =>
            {
                if (string.Equals(e.FullPath, record.LocalPath, StringComparison.OrdinalIgnoreCase))
                    Poke();
            };
            _watcher.EnableRaisingEvents = true;
        }

        public CopyRecord Record { get; }

        /// <summary>감시 기간(12시간)이 지났다</summary>
        public bool IsExpired => DateTime.UtcNow - Record.OpenedAt > WatchLifetime;

        // 저장이 끝날 때까지(여러 번 쓰기) 잠깐 기다렸다 보낸다
        public void Poke()
        {
            if (_watcher is not null)
                _debounce.Change(1500, Timeout.Infinite);
        }

        /// <summary>사본 내용이 원래 PC로 보낸 내용과 다르면 true (아직 못 보낸 저장)</summary>
        public bool HasPendingChanges()
        {
            if (Record.ReadOnly || !File.Exists(Record.LocalPath))
                return false;
            try
            {
                using var stream = new FileStream(Record.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                return Convert.ToHexString(SHA256.HashData(stream)) != Record.SyncedHash;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true; // 못 읽으면 안전하게 지우지 않는다
            }
        }

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
                if (hash == Record.SyncedHash)
                    return;

                var result = await _owner.UploadAsync(Record, content);
                if (!result.Success)
                {
                    _owner._logger.LogWarning("편집 저장을 원래 PC로 보내지 못했습니다 {Path}: {Error}", Record.SourcePath, result.Error);
                    return; // 정리 주기에 다시 시도
                }
                Record.SyncedHash = hash;
                Record.BaseHash = result.Hash ?? hash;
                // 그 사이 원래 파일이 바뀌어 옆에 새 이름으로 저장했다 → 이후 저장도 그 파일로
                if (result.Conflict && result.SavedPath is not null)
                    Record.SourcePath = result.SavedPath;
                _owner.SaveManifest();
                _owner._logger.LogInformation("편집 저장 → {Source}{Conflict}", result.SavedPath, result.Conflict ? " (충돌: 새 이름)" : "");
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException or TaskCanceledException or UnauthorizedAccessException)
            {
                _owner._logger.LogWarning("편집 저장 실패 {Path}: {Message}", Record.LocalPath, ex.Message);
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
                    if (!File.Exists(Record.LocalPath))
                        return null;
                    await using var stream = new FileStream(Record.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
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

        public void Dispose()
        {
            _watcher?.Dispose();
            _debounce.Dispose();
        }
    }
}
