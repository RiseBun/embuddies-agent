using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class NativePet : Form
{
    private const int Side = 260;
    private const int UlwAlpha = 2;
    private const int WmNcHitTest = 0x84;
    private const int WmNcLeftDoubleClick = 0xA3;
    private const int WmNcRightButtonUp = 0xA5;
    private const int HtClient = 1;
    private const int HtCaption = 2;
    private readonly string panelUrl;
    private readonly string panelProfile;
    private readonly Timer animation = new Timer();
    private readonly Stopwatch animationClock = Stopwatch.StartNew();
    private readonly NotifyIcon tray = new NotifyIcon();
    private double gazeX;
    private double gazeY;
    private long lastFrameMilliseconds;
    private Process panelProcess;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X, Y; public NativePoint(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize { public int Width, Height; public NativeSize(int width, int height) { Width = width; Height = height; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BlendFunction { public byte Op, Flags, ConstantAlpha, AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ClrUsed, ClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfo { public BitmapInfoHeader Header; public uint Color; }

    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info,
        uint usage, out IntPtr pixels, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr bitmap);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr bitmap);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screenDc,
        ref NativePoint destination, ref NativeSize size, IntPtr sourceDc, ref NativePoint source,
        int colorKey, ref BlendFunction blend, int flags);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= 0x00080000;
            return parameters;
        }
    }

    private NativePet(string url, string profile)
    {
        panelUrl = url;
        panelProfile = profile;
        Text = "embuddies";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(Side, Side);
        var area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Side - 24, area.Bottom - Side - 24);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开工作台", null, (sender, args) => OpenPanel());
        menu.Items.Add("隐藏embuddies", null, (sender, args) => { animation.Stop(); Hide(); });
        menu.Items.Add("退出embuddies", null, (sender, args) => Close());
        ContextMenuStrip = menu;

        using (var iconImage = DrawFrame(0, 0, 25))
        {
            var handle = iconImage.GetHicon();
            try { tray.Icon = (Icon)Icon.FromHandle(handle).Clone(); }
            finally { DestroyIcon(handle); }
        }
        tray.Text = "embuddies";
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (sender, args) => Restore();
        tray.Visible = true;

        animation.Interval = 16;
        animation.Tick += (sender, args) => Animate();
        Shown += (sender, args) => { Render(); animation.Start(); };
        FormClosed += (sender, args) => {
            animation.Stop();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
            if (panelProcess != null)
            {
                if (!panelProcess.HasExited) panelProcess.CloseMainWindow();
                panelProcess.Dispose();
            }
        };
    }

    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);

    private void Restore()
    {
        Show();
        WindowState = FormWindowState.Normal;
        ShowWindowAsync(Handle, 9);
        SetForegroundWindow(Handle);
        lastFrameMilliseconds = animationClock.ElapsedMilliseconds;
        animation.Start();
        Render();
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmNcLeftDoubleClick)
        {
            OpenPanel();
            return;
        }
        if (message.Msg == WmNcRightButtonUp)
        {
            ContextMenuStrip.Show(Cursor.Position);
            return;
        }
        base.WndProc(ref message);
        if (message.Msg == WmNcHitTest && message.Result == (IntPtr)HtClient)
            message.Result = (IntPtr)HtCaption;
    }

    private void OpenPanel()
    {
        try
        {
            if (panelProcess != null)
            {
                panelProcess.Refresh();
                if (!panelProcess.HasExited)
                {
                    if (panelProcess.MainWindowHandle != IntPtr.Zero)
                    {
                        ShowWindowAsync(panelProcess.MainWindowHandle, 9);
                        SetForegroundWindow(panelProcess.MainWindowHandle);
                    }
                    return;
                }
                panelProcess.Dispose();
                panelProcess = null;
            }
            var host = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "EmbuddiesPanel.exe");
            if (!File.Exists(host))
                throw new FileNotFoundException("embuddies 工作台程序缺失，请重新构建或解压应用。", host);
            var info = new ProcessStartInfo(host,
                "\"" + panelUrl + "\" \"" + panelProfile + "\"");
            info.UseShellExecute = false;
            panelProcess = Process.Start(info);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "embuddies 无法打开工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void Animate()
    {
        var now = animationClock.ElapsedMilliseconds;
        var elapsed = Math.Max(1, Math.Min(100, now - lastFrameMilliseconds));
        lastFrameMilliseconds = now;
        var cursor = Cursor.Position;
        var targetX = Math.Max(-1, Math.Min(1, (cursor.X - Left - Side / 2.0) / (Side * 0.65)));
        var targetY = Math.Max(-1, Math.Min(1, (cursor.Y - Top - Side / 2.0) / (Side * 0.65)));
        var follow = 1 - Math.Pow(0.88, elapsed / (1000.0 / 60));
        gazeX += (targetX - gazeX) * follow;
        gazeY += (targetY - gazeY) * follow;
        var blink = now % 3800;
        var eyeHeight = blink >= 3300 && blink <= 3560
            ? Math.Max(1.2, 25 * (1 - Math.Sin(Math.PI * (blink - 3300) / 260) * 0.95))
            : 25;
        Render(eyeHeight);
    }

    private static GraphicsPath BodyPath()
    {
        var shape = new GraphicsPath(FillMode.Alternate);
        shape.StartFigure();
        shape.AddBezier(158, 29, 224, 28, 271, 69, 272, 126);
        shape.AddBezier(272, 126, 273, 184, 226, 226, 161, 229);
        shape.AddBezier(161, 229, 96, 230, 48, 188, 48, 130);
        shape.AddBezier(48, 130, 47, 72, 93, 32, 158, 29);
        shape.CloseFigure();
        shape.StartFigure();
        shape.AddBezier(158, 37, 99, 40, 56, 76, 56, 130);
        shape.AddBezier(56, 130, 56, 180, 102, 216, 161, 216);
        shape.AddBezier(161, 216, 220, 213, 264, 177, 264, 126);
        shape.AddBezier(264, 126, 263, 75, 218, 36, 158, 37);
        shape.CloseFigure();
        return shape;
    }

    private static Bitmap DrawFrame(double gazeX, double gazeY, double eyeHeight)
    {
        var image = new Bitmap(Side, Side, PixelFormat.Format32bppPArgb);
        using (var graphics = Graphics.FromImage(image))
        using (var brush = new SolidBrush(Color.FromArgb(34, 214, 208)))
        using (var hitArea = new SolidBrush(Color.FromArgb(1, 34, 214, 208)))
        using (var body = BodyPath())
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TranslateTransform(-30, 0);
            graphics.FillEllipse(hitArea, 56, 37, 208, 179);
            graphics.FillPath(brush, body);
            var moveX = (float)(gazeX * 54);
            var moveY = (float)(gazeY * 45);
            var spread = (float)(gazeX * 8);
            var radiusY = (float)eyeHeight;
            graphics.FillEllipse(brush, 126 + moveX - spread - 25, 128 + moveY - radiusY, 50, radiusY * 2);
            graphics.FillEllipse(brush, 194 + moveX + spread - 25, 128 + moveY - radiusY, 50, radiusY * 2);
        }
        return image;
    }

    private void Render(double eyeHeight = 25)
    {
        using (var image = DrawFrame(gazeX, gazeY, eyeHeight))
        {
            var screenDc = GetDC(IntPtr.Zero);
            var memoryDc = CreateCompatibleDC(screenDc);
            var info = new BitmapInfo {
                Header = new BitmapInfoHeader {
                    Size = 40, Width = Side, Height = -Side, Planes = 1,
                    BitCount = 32, Compression = 0, SizeImage = Side * Side * 4
                }
            };
            IntPtr pixels;
            var bitmap = CreateDIBSection(memoryDc, ref info, 0, out pixels, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || pixels == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法创建embuddies透明图像");
            var imageData = image.LockBits(new Rectangle(0, 0, Side, Side),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
            try
            {
                var row = new byte[Side * 4];
                for (var y = 0; y < Side; y++)
                {
                    Marshal.Copy(IntPtr.Add(imageData.Scan0, y * imageData.Stride), row, 0, row.Length);
                    Marshal.Copy(row, 0, IntPtr.Add(pixels, y * row.Length), row.Length);
                }
            }
            finally { image.UnlockBits(imageData); }
            var old = SelectObject(memoryDc, bitmap);
            try
            {
                var position = new NativePoint(Left, Top);
                var size = new NativeSize(Side, Side);
                var origin = new NativePoint(0, 0);
                var blend = new BlendFunction { Op = 0, Flags = 0, ConstantAlpha = 255, AlphaFormat = 1 };
                if (!UpdateLayeredWindow(Handle, screenDc, ref position, ref size,
                    memoryDc, ref origin, 0, ref blend, UlwAlpha))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "无法显示embuddies透明窗口");
            }
            finally
            {
                SelectObject(memoryDc, old);
                DeleteObject(bitmap);
                DeleteDC(memoryDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--render-preview")
        {
            using (var image = DrawFrame(0, 0, 25)) image.Save(args[1], ImageFormat.Png);
            return;
        }
        if (args.Length != 2 || !Uri.IsWellFormedUriString(args[0], UriKind.Absolute))
        {
            MessageBox.Show("启动参数不完整，请使用“启动embuddies.cmd”或“embuddies.exe”。", "embuddies 启动失败");
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new NativePet(args[0], args[1]));
    }
}

