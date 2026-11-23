using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinProbe
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr h, int i);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static string Dump(uint[] pids)
    {
        var sb = new StringBuilder();
        EnumWindows((h, l) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            bool match = false;
            foreach (var p in pids) if (p == pid) { match = true; break; }
            if (!match) return true;

            var title = new StringBuilder(512);
            GetWindowTextW(h, title, 512);
            var cls = new StringBuilder(256);
            GetClassNameW(h, cls, 256);
            RECT r; GetWindowRect(h, out r);
            long ex = (long)GetWindowLongPtr(h, -20);
            long st = (long)GetWindowLongPtr(h, -16);
            sb.AppendLine(string.Format(
                "hwnd=0x{0:X} pid={1} vis={2} iconic={3} rect=[{4},{5} {6}x{7}] class={8} title=[{9}] ex=0x{10:X} style=0x{11:X}",
                h.ToInt64(), pid, IsWindowVisible(h), IsIconic(h),
                r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
                cls.ToString(), title.ToString(), ex, st));
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }
}
