using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const int DefaultRuntimePort = 31338;
    private const string ActivationEventName = "embuddies.Activate";
    private static readonly string LaunchLog = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "embuddies", "launcher.log");
    private static volatile Process activePet;

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr extra);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int length);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    private delegate bool WindowCallback(IntPtr window, IntPtr extra);

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LaunchLog));
            File.AppendAllText(LaunchLog, DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    private static IntPtr FindPetWindow(int processId)
    {
        var found = IntPtr.Zero;
        EnumWindows((window, extra) =>
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId) return true;
            var title = new StringBuilder(64);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString() != "embuddies") return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static void SignalExistingInstance()
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                using (var signal = EventWaitHandle.OpenExisting(ActivationEventName)) signal.Set();
                return;
            }
            catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(100); }
        }
    }

    [STAThread]
    private static int Main()
    {
        Log("launcher start");
        bool firstInstance;
        using (var mutex = new Mutex(true, "embuddies.SingleInstance", out firstInstance))
        {
            if (!firstInstance) { SignalExistingInstance(); return 0; }
            using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationEventName))
            {
                var activationThread = new Thread(() =>
                {
                    while (true)
                    {
                        activation.WaitOne();
                        var pet = activePet;
                        if (pet == null) continue;
                        try
                        {
                            var window = FindPetWindow(pet.Id);
                            if (window != IntPtr.Zero) PostMessage(window, 0xA3, new IntPtr(2), IntPtr.Zero);
                        }
                        catch (InvalidOperationException) { }
                    }
                });
                activationThread.IsBackground = true;
                activationThread.Start();

                Process runtime = null;
                var ownsRuntime = false;
                try
                {
                    var baseDir = Path.GetDirectoryName(typeof(Program).Assembly.Location);
                    var runtimeDir = Path.Combine(baseDir, "runtime");
                    var defaultDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "embuddies", "data");
                    var requestedDataDir = Environment.GetEnvironmentVariable("EMBUDDIES_DATA_DIR");
                    var dataDir = String.IsNullOrWhiteSpace(requestedDataDir)
                        ? defaultDataDir
                        : Path.GetFullPath(requestedDataDir);
                    var nodePath = Path.Combine(runtimeDir, "node.exe");
                    var petPath = Path.Combine(baseDir, "EmbuddiesPet.exe");
                    var panelPath = Path.Combine(baseDir, "EmbuddiesPanel.exe");
                    if (!File.Exists(nodePath) || !File.Exists(petPath) || !File.Exists(panelPath))
                        throw new InvalidOperationException("embuddies 安装不完整，请重新解压完整的 Windows 发布包。");

                    var tokenPath = Path.Combine(dataDir, "api-token");
                    var apiToken = File.Exists(tokenPath) ? File.ReadAllText(tokenPath).Trim() : "";
                    if (String.IsNullOrEmpty(apiToken)) apiToken = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
                    var runtimePort = IsRuntimeListening(DefaultRuntimePort, apiToken)
                        ? DefaultRuntimePort
                        : FindAvailablePort(DefaultRuntimePort);
                    if (!IsRuntimeListening(runtimePort, apiToken))
                    {
                        var runtimeInfo = new ProcessStartInfo
                        {
                            FileName = nodePath,
                            Arguments = "\"server.mjs\"",
                            WorkingDirectory = runtimeDir,
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            WindowStyle = ProcessWindowStyle.Hidden
                        };
                        runtimeInfo.EnvironmentVariables["EMBUDDIES_API_TOKEN"] = apiToken;
                        runtimeInfo.EnvironmentVariables["EMBUDDIES_DATA_DIR"] = dataDir;
                        runtimeInfo.EnvironmentVariables["EMBUDDIES_PORT"] = runtimePort.ToString(CultureInfo.InvariantCulture);
                        runtimeInfo.EnvironmentVariables["EMBUDDIES_UI_ROOT"] = Path.Combine(baseDir, "shell", "resources");
                        runtime = Process.Start(runtimeInfo);
                        ownsRuntime = true;
                        var ready = false;
                        for (var attempt = 0; attempt < 150; attempt++)
                        {
                            Thread.Sleep(100);
                            if (runtime.HasExited)
                                throw new InvalidOperationException("embuddies 运行时意外退出，代码：" + runtime.ExitCode);
                            if (IsRuntimeListening(runtimePort, apiToken)) { ready = true; break; }
                        }
                        if (!ready) throw new InvalidOperationException("embuddies 运行时没有在预期时间内就绪。日志：%LOCALAPPDATA%\\embuddies\\launcher.log");
                    }

                    var profile = Path.Combine(Path.GetDirectoryName(dataDir), "webview2-profile");
                    var url = "http://127.0.0.1:" + runtimePort + "/?panel=1&nativePanel=1&apiPort=" + runtimePort
                        + "&apiToken=" + Uri.EscapeDataString(apiToken);
                    var petInfo = new ProcessStartInfo
                    {
                        FileName = petPath,
                        Arguments = "\"" + url + "\" \"" + profile + "\"",
                        WorkingDirectory = baseDir,
                        UseShellExecute = false
                    };
                    using (var pet = Process.Start(petInfo))
                    {
                        activePet = pet;
                        Log("native pet pid " + pet.Id);
                        while (!pet.WaitForExit(500))
                        {
                            if (!ownsRuntime || runtime == null || !runtime.HasExited)
                                continue;
                            Log("runtime exited while the desktop surface was open; restarting");
                            var restartInfo = new ProcessStartInfo
                            {
                                FileName = nodePath,
                                Arguments = "\"server.mjs\"",
                                WorkingDirectory = runtimeDir,
                                UseShellExecute = false,
                                CreateNoWindow = true,
                                WindowStyle = ProcessWindowStyle.Hidden
                            };
                            restartInfo.EnvironmentVariables["EMBUDDIES_API_TOKEN"] = apiToken;
                            restartInfo.EnvironmentVariables["EMBUDDIES_DATA_DIR"] = dataDir;
                            restartInfo.EnvironmentVariables["EMBUDDIES_PORT"] = runtimePort.ToString(CultureInfo.InvariantCulture);
                            restartInfo.EnvironmentVariables["EMBUDDIES_UI_ROOT"] = Path.Combine(baseDir, "shell", "resources");
                            runtime = Process.Start(restartInfo);
                            var recovered = false;
                            for (var attempt = 0; attempt < 150; attempt++)
                            {
                                Thread.Sleep(100);
                                if (runtime.HasExited) break;
                                if (IsRuntimeListening(runtimePort, apiToken)) { recovered = true; break; }
                            }
                            if (!recovered)
                                throw new InvalidOperationException("embuddies 运行时恢复失败，请重新启动应用。日志：%LOCALAPPDATA%\\embuddies\\launcher.log");
                            Log("runtime recovered on port " + runtimePort);
                        }
                        Log("native pet exit " + pet.ExitCode);
                    }
                    return 0;
                }
                catch (Exception error)
                {
                    Log("error " + error);
                    MessageBox.Show(error.Message, "embuddies Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally
                {
                    if (ownsRuntime && runtime != null && !runtime.HasExited)
                    {
                        try { runtime.Kill(); } catch { }
                    }
                }
            }
        }
    }

    private static int FindAvailablePort(int preferred)
    {
        for (var port = preferred; port < preferred + 32; port++)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                try {
                    listener.Start();
                    listener.Stop();
                    return port;
                } finally { try { listener.Stop(); } catch { } }
            }
            catch (SocketException) { }
        }
        var fallback = new TcpListener(IPAddress.Loopback, 0);
        try {
            var listener = fallback;
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        } finally { try { fallback.Stop(); } catch { } }
    }

    private static bool IsRuntimeListening(int port, string apiToken)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
            request.Method = "GET";
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            request.Proxy = null;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + apiToken;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                var body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK
                    && body.IndexOf("\"service\":\"embuddies-agent-runtime\"", StringComparison.Ordinal) >= 0;
            }
        }
        catch (WebException) { return false; }
        catch (IOException) { return false; }
        catch (InvalidOperationException) { return false; }
    }
}

