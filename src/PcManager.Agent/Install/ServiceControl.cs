using System.ServiceProcess;

namespace PcManager.Agent.Install;

/// <summary>런처에서 서비스를 시작한다 (필요하면 UAC로 승격). 중지는 서비스가 파이프로 스스로 한다.</summary>
internal static class ServiceControl
{
    public static int StartService()
    {
        if (!ElevationHelper.IsElevated)
        {
            if (ElevationHelper.TryRelaunchElevated("--start-service --elevated", out var code))
                return code;
            MessageBox.Show("에이전트를 시작하려면 관리자 권한이 필요합니다.", "PC Manager 에이전트",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        try
        {
            using var service = new ServiceController(AgentHost.ServiceName);
            if (service.Status is not (ServiceControllerStatus.Running or ServiceControllerStatus.StartPending))
            {
                service.Start();
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            }
            return 0;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ServiceProcess.TimeoutException)
        {
            MessageBox.Show($"에이전트 시작 실패: {ex.Message}", "PC Manager 에이전트",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
