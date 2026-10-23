using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class DpiProbe
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("Shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

    private static int Main(string[] args)
    {
        int x, y;
        if (args.Length != 2 || !Int32.TryParse(args[0], out x) || !Int32.TryParse(args[1], out y)) return 2;
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            var monitor = MonitorFromPoint(new Point { X = x, Y = y }, 2);
            uint dpiX, dpiY;
            if (monitor == IntPtr.Zero || GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) != 0) return 1;
            Console.WriteLine((dpiX / 96.0).ToString("0.###", CultureInfo.InvariantCulture));
            return 0;
        }
        catch { return 1; }
    }
}
