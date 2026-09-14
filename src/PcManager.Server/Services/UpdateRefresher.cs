using Microsoft.Extensions.Options;

namespace PcManager.Server.Services;

/// <summary>시작 직후와 주기적으로 업데이트를 확인한다.</summary>
public class UpdateRefresher(UpdateService updates, IOptions<ServerOptions> options) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = options.Value.UpdateCheckIntervalMinutes;

        // 시작 후 네트워크가 준비될 때까지 잠깐 기다렸다가 첫 확인
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            await updates.CheckAsync(stoppingToken);
            if (interval <= 0)
                return; // 자동 확인 끔

            try
            {
                await Task.Delay(TimeSpan.FromMinutes(interval), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }
}
