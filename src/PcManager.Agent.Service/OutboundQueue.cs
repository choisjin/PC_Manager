using System.Threading.Channels;

namespace PcManager.Agent.Service;

/// <summary>
/// 서버로 보낼 보고(CommandStarted, CommandOutput, CommandCompleted) 큐.
/// 연결이 끊겨도 순서대로 보관했다가 재접속 후 전송한다.
/// </summary>
public class OutboundQueue
{
    // 장시간 끊긴 상태에서 출력이 쏟아지면 오래된 것부터 버린다
    private readonly Channel<object> _channel = Channel.CreateBounded<object>(
        new BoundedChannelOptions(100_000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });

    public ChannelReader<object> Reader => _channel.Reader;

    public void Enqueue(object message) => _channel.Writer.TryWrite(message);
}
