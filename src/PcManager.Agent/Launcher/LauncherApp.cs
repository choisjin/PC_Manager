namespace PcManager.Agent.Launcher;

/// <summary>트레이 런처 진입점. 사용자 세션마다 하나만 실행된다.</summary>
internal static class LauncherApp
{
    private const string MutexName = @"Local\PcManager.Launcher";
    private const string ShowEventName = @"Local\PcManager.Launcher.Show";

    /// <param name="showWindow">false면 트레이에만 표시 (로그인 시 자동 실행)</param>
    public static int Run(bool showWindow)
    {
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        if (!createdNew)
        {
            // 이미 실행 중이면 그 창을 띄우라고 알리고 끝낸다
            if (showWindow)
                showEvent.Set();
            return 0;
        }

        ApplicationConfiguration.Initialize();
        using var context = new LauncherContext(showEvent, showWindow);
        Application.Run(context);
        GC.KeepAlive(mutex);
        return 0;
    }
}
