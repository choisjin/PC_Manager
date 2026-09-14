using System.Drawing.Drawing2D;

namespace PcManager.Agent.Launcher;

/// <summary>상태별 트레이 아이콘 (모니터 모양 + 상태 점). 이미지 파일 없이 코드로 그린다.</summary>
internal static class TrayIcons
{
    public static readonly Color ConnectedColor = Color.FromArgb(34, 160, 90);
    public static readonly Color ConnectingColor = Color.FromArgb(230, 160, 30);
    public static readonly Color DisconnectedColor = Color.FromArgb(140, 146, 156);
    public static readonly Color ErrorColor = Color.FromArgb(210, 60, 60);

    public static Icon Connected { get; } = Create(ConnectedColor);
    public static Icon Connecting { get; } = Create(ConnectingColor);
    public static Icon Disconnected { get; } = Create(DisconnectedColor);
    public static Icon Unknown { get; } = Create(ErrorColor);

    private static Icon Create(Color statusColor)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using var frame = new SolidBrush(Color.FromArgb(55, 65, 81));
            using var screen = new SolidBrush(Color.FromArgb(147, 197, 253));
            g.FillRectangle(frame, 2, 4, 26, 18);
            g.FillRectangle(screen, 4, 6, 22, 14);
            g.FillRectangle(frame, 12, 22, 6, 3);
            g.FillRectangle(frame, 8, 25, 14, 2);

            using var outline = new SolidBrush(Color.White);
            using var dot = new SolidBrush(statusColor);
            g.FillEllipse(outline, 16, 16, 16, 16);
            g.FillEllipse(dot, 18, 18, 12, 12);
        }
        // 프로세스 수명 동안 쓰는 아이콘이라 핸들을 해제하지 않는다
        return Icon.FromHandle(bitmap.GetHicon());
    }
}
