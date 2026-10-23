using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DpiHelper
{
    public delegate bool WindowCallback(IntPtr window, IntPtr extra);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForSystem();

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(WindowCallback callback, IntPtr extra);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder title, int length);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    public static IntPtr FindEmbuddiesWindow(int processId)
    {
        var found = IntPtr.Zero;
        EnumWindows((window, extra) =>
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString() != "embuddies") return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
