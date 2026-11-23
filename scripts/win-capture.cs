using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCapture
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr h, int cmd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetWindowDisplayAffinity(IntPtr h, uint aff);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint aff);

    /// <summary>读防截屏状态：0=可截屏 0x11=WDA_EXCLUDEFROMCAPTURE</summary>
    public static string Affinity(IntPtr h)
    {
        if (h == IntPtr.Zero) return "NOT_FOUND";
        uint a; GetWindowDisplayAffinity(h, out a);
        return string.Format("affinity=0x{0:X} ({1})", a,
            a == 0x11 ? "WDA_EXCLUDEFROMCAPTURE=不可截屏" : a == 0 ? "可截屏" : "其他");
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10;
    public const uint WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11;
    public const uint PW_RENDERFULLCONTENT = 0x2;

    public static IntPtr FindByTitle(string needle)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            var sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            if (sb.ToString().Contains(needle)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Show(IntPtr h, bool show)
    {
        if (h == IntPtr.Zero) return "NOT_FOUND";
        if (show)
        {
            ShowWindow(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        else ShowWindow(h, SW_HIDE);
        return Describe(h);
    }

    public static string Describe(IntPtr h)
    {
        if (h == IntPtr.Zero) return "NOT_FOUND";
        RECT r; GetWindowRect(h, out r);
        return string.Format("vis={0} rect=[{1},{2} {3}x{4}]",
            IsWindowVisible(h), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    public static bool SetWda(IntPtr h, bool on)
        => h != IntPtr.Zero && SetWindowDisplayAffinity(h, on ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);

    /// <summary>把窗口自身内容画到目标 HDC（对分层/透明窗口需 PW_RENDERFULLCONTENT）</summary>
    public static bool Render(IntPtr h, IntPtr hdc, bool fullContent)
        => PrintWindow(h, hdc, fullContent ? PW_RENDERFULLCONTENT : 0);
}
