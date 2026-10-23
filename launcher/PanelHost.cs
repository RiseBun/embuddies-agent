using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class PanelHost : Form
{
    private readonly Uri page;
    private readonly string profile;
    private readonly WebView2 view = new WebView2();

    private void Log(string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(profile, "panel.log"),
                DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    private PanelHost(Uri page, string profile)
    {
        this.page = page;
        this.profile = profile;
        Text = "embuddies";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        var area = Screen.PrimaryScreen.WorkingArea;
        ClientSize = new Size(Math.Min(1040, Math.Max(200, area.Width - 48)),
            Math.Min(720, Math.Max(200, area.Height - 48)));
        MinimumSize = new Size(Math.Min(480, Math.Max(200, area.Width - 64)),
            Math.Min(360, Math.Max(200, area.Height - 80)));
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        Shown += async (sender, args) =>
        {
            try
            {
                string webViewVersion;
                try
                {
                    webViewVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
                }
                catch (Exception error)
                {
                    Log("WebView2 runtime unavailable: " + error);
                    MessageBox.Show(
                        "embuddies 需要 Microsoft Edge WebView2 Runtime 才能打开工作台。\n\n请安装 WebView2 Runtime 后重新启动 embuddies。Windows 10/11 通常已经包含它；如果是精简系统，请从 Microsoft 官方安装 Evergreen Runtime。",
                        "embuddies 缺少运行组件",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                    Close();
                    return;
                }
                Log("WebView2 runtime " + webViewVersion);
                var environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await view.EnsureCoreWebView2Async(environment);
                view.CoreWebView2.NavigationStarting += (source, navigation) =>
                {
                    Uri target;
                    if (!Uri.TryCreate(navigation.Uri, UriKind.Absolute, out target) ||
                        target.Scheme != Uri.UriSchemeHttp || target.Authority != page.Authority)
                        navigation.Cancel = true;
                };
                view.CoreWebView2.NewWindowRequested += (source, request) => request.Handled = true;
                view.CoreWebView2.NavigationCompleted += (source, navigation) =>
                    Log(navigation.IsSuccess ? "page loaded" : "navigation failed: " + navigation.WebErrorStatus);
                view.CoreWebView2.WebMessageReceived += (source, message) =>
                {
                    if (message.TryGetWebMessageAsString() == "embuddies-ready")
                        Log("ui ready");
                };
                view.CoreWebView2.Navigate(page.AbsoluteUri);
            }
            catch (Exception error)
            {
                Log("startup failed: " + error);
                MessageBox.Show(error.Message, "embuddies工作台启动失败",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        };
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Uri page;
        if (args.Length != 2 || !Uri.TryCreate(args[0], UriKind.Absolute, out page) ||
            page.Scheme != Uri.UriSchemeHttp || !page.IsLoopback)
        {
            MessageBox.Show("工作台启动参数不完整，请从embuddies悬浮窗打开。", "embuddies启动失败");
            return 1;
        }
        Directory.CreateDirectory(args[1]);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PanelHost(page, args[1]));
        return 0;
    }
}

