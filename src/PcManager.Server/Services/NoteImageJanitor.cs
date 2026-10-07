namespace PcManager.Server.Services;

/// <summary>
/// 어느 메모에도 없는 이미지를 주기적으로 지운다 (시작 직후·6시간마다).
/// 올린 지 하루가 안 된 이미지는 남긴다: 아직 저장 전이거나, 지웠다가 되돌리기로 다시 넣을 수 있다
/// </summary>
public class NoteImageJanitor(NoteStore notes, ILogger<NoteImageJanitor> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);
    private static readonly TimeSpan MinAge = TimeSpan.FromDays(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    var deleted = notes.CleanupUnusedImages(MinAge);
                    if (deleted > 0)
                        logger.LogInformation("안 쓰는 메모 이미지 {Count}개를 지웠습니다", deleted);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    logger.LogWarning("메모 이미지 정리 실패: {Message}", ex.Message);
                }
                await Task.Delay(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
