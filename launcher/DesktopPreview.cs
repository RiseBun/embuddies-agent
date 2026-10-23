using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal static class DesktopPreview
{
    [STAThread]
    private static int Main()
    {
        var root = Path.GetDirectoryName(typeof(DesktopPreview).Assembly.Location);
        var host = Path.Combine(root, "desktop-host", "electron.exe");
        var app = Path.Combine(root, "desktop-host", "resources", "app");
        var node = Path.Combine(root, "runtime", "node.exe");
        var log = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "embuddies", "desktop-launcher.log");
        try
        {
            if (!File.Exists(host) || !File.Exists(Path.Combine(app, "main.cjs")) || !File.Exists(node))
                throw new InvalidOperationException("桌面程序文件不完整，请重新解压整个便携包。");
            var info = new ProcessStartInfo(host)
            {
                WorkingDirectory = Path.GetDirectoryName(host),
                UseShellExecute = false
            };
        info.EnvironmentVariables["EMBUDDIES_BUNDLE_ROOT"] = root;
        info.EnvironmentVariables["EMBUDDIES_NODE"] = node;
            using (var process = Process.Start(info))
            {
                if (process == null) throw new InvalidOperationException("无法创建embuddies桌面进程。");
                Thread.Sleep(3000);
                if (process.HasExited && process.ExitCode != 0)
                    throw new InvalidOperationException("桌面窗口启动失败，退出码：" + process.ExitCode);
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(log));
                File.AppendAllText(log, DateTime.UtcNow.ToString("O") + " " + error + Environment.NewLine);
            }
            catch { }
            MessageBox.Show(error.Message + Environment.NewLine + log,
                "embuddies桌面版启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

