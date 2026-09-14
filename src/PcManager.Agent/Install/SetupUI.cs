using System.Diagnostics;

namespace PcManager.Agent.Install;

/// <summary>더블클릭 설치/제거 진행 창. 로그를 보여주고 끝나면 런처를 띄운다.</summary>
internal static class SetupUI
{
    public static int Install()
    {
        // 관리자 권한이 없으면 UAC로 자기 자신을 다시 실행
        if (!ElevationHelper.IsElevated)
        {
            if (ElevationHelper.TryRelaunchElevated("--install --elevated", out var code))
                return code;
            MessageBox.Show("설치하려면 관리자 권한이 필요합니다.", "PC Manager 에이전트 설치",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        return RunWithWindow("PC Manager 에이전트 설치", log =>
        {
            ServiceInstaller.Install(log);
            log("");
            log("설치가 완료되었습니다.");
            log("잠시 후 화면 오른쪽 아래에 에이전트 창이 열립니다.");
            log("서버 주소를 입력하고 [연결]을 누르세요.");

            // 지금 이 관리자 세션이 아니라 로그인 사용자 세션에 런처를 띄우도록 서비스가 처리한다.
            // 즉시 보여주기 위해 여기서도 한 번 실행한다 (관리자 세션 = 사용자 세션인 경우가 많음).
            TryStartLauncher();
        }, autoCloseOnSuccess: true);
    }

    public static int Uninstall(bool removeData)
    {
        if (!ElevationHelper.IsElevated)
        {
            var args = removeData ? "--uninstall --purge --elevated" : "--uninstall --elevated";
            if (ElevationHelper.TryRelaunchElevated(args, out var code))
                return code;
            MessageBox.Show("제거하려면 관리자 권한이 필요합니다.", "PC Manager 에이전트 제거",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        return RunWithWindow("PC Manager 에이전트 제거", log =>
        {
            ServiceInstaller.Uninstall(removeData, log);
            log("");
            log("제거가 완료되었습니다.");
        }, autoCloseOnSuccess: false);
    }

    private static int RunWithWindow(string title, Action<Action<string>> work, bool autoCloseOnSuccess)
    {
        ApplicationConfiguration.Initialize();
        using var form = new SetupForm(title);
        var exitCode = 0;

        form.Shown += async (_, _) =>
        {
            try
            {
                await Task.Run(() => work(form.Log));
                form.Finish(success: true, autoClose: autoCloseOnSuccess);
            }
            catch (Exception ex)
            {
                form.Log("");
                form.Log($"오류: {ex.Message}");
                form.Finish(success: false, autoClose: false);
                exitCode = 1;
            }
        };
        Application.Run(form);
        return exitCode;
    }

    private static void TryStartLauncher()
    {
        try
        {
            Process.Start(new ProcessStartInfo(ServiceInstaller.InstalledExePath, "--launcher") { UseShellExecute = false });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            // 서비스가 세션에 곧 띄운다
        }
    }
}
