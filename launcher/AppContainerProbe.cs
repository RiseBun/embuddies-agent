using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Standalone probe: launches powershell.exe inside an AppContainer and reports
// whether it starts, can write the workspace, and cannot read the user profile.
// Usage: AppContainerProbe.exe --workspace <dir>
internal static class AppContainerProbe
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int HRESULT_ALREADY_EXISTS = unchecked((int)0x800700B7);
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES =
        new IntPtr(0x00020009);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string name, string displayName, string description,
        IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string name, out IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment,
        string currentDirectory, ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    private static string logPath;

    private static void Log(string message)
    {
        Console.WriteLine(message);
        if (logPath != null)
        {
            try { File.AppendAllText(logPath, message + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }
    }

    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Log("error=" + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        string workspace = null;
        for (int i = 0; i < args.Length; i++)
            if (args[i] == "--workspace" && i + 1 < args.Length) workspace = args[++i];
        if (string.IsNullOrEmpty(workspace))
            workspace = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "ac-probe");
        try
        {
            workspace = Path.GetFullPath(workspace);
            Directory.CreateDirectory(workspace);
        }
        catch (Exception error)
        {
            Console.WriteLine("workspace_error=" + error.Message);
            return 2;
        }
        logPath = Path.Combine(workspace, "ac-probe.log");

        // 1. AppContainer profile (create, or fall back to a derived SID when the
        //    profile store is unavailable in this session).
        IntPtr sid;
        int hr = CreateAppContainerProfile(
            "embuddies.probe", "embuddies probe", "probe", IntPtr.Zero, 0, out sid);
        Log("profile_hr=0x" + hr.ToString("X8"));
        if (hr != 0)
            hr = DeriveAppContainerSidFromAppContainerName("embuddies.probe", out sid);
        if (hr != 0)
        {
            Log("derive_hr=0x" + hr.ToString("X8"));
            return 3;
        }

        // 2. Grant the workspace to the AppContainer SID.
        IntPtr stringSidPtr;
        ConvertSidToStringSid(sid, out stringSidPtr);
        string stringSid = Marshal.PtrToStringUni(stringSidPtr);
        string grant = RunTool("icacls",
            "\"" + workspace + "\" /grant *" + stringSid + ":(OI)(CI)(RX,W) /Q");
        Log("grant=" + grant.Replace("\r", " ").Replace("\n", " ").Trim());

        // 3. Launch powershell inside the AppContainer; it writes a result file.
        string resultPath = Path.Combine(workspace, "ac-result.txt");
        try { File.Delete(resultPath); } catch { }
        string script =
            "$ws = '" + workspace.Replace("'", "''") + "'; " +
            "try { Set-Content -Path (Join-Path $ws 'ac-write.txt') -Value 'ok' -ErrorAction Stop; $w='1' } catch { $w='0' }; " +
            "$d='0'; try { $null = Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -ErrorAction Stop; $d='1' } catch { }; " +
            "Set-Content -Path (Join-Path $ws 'ac-result.txt') -Value \"write=$w desktop=$d\" -ErrorAction SilentlyContinue";

        string launchError;
        bool started = LaunchInAppContainer(sid, script, workspace, out launchError);
        Log("started=" + started + (started ? "" : " error=" + launchError));

        bool wrote = false;
        string result = "";
        if (File.Exists(resultPath))
        {
            wrote = true;
            result = File.ReadAllText(resultPath).Trim();
        }
        bool writeOk = File.Exists(Path.Combine(workspace, "ac-write.txt"));
        Log("workspaceWrite=" + (writeOk ? "1" : "0"));
        Log("result=" + result);
        bool desktopBlocked = result.Contains("desktop=0");
        bool pass = started && writeOk && desktopBlocked;
        Log("verdict=" + (pass ? "PASS" : "FAIL"));
        if (!pass)
        {
            if (!started) Log("reason=appcontainer_launch_failed");
            else if (!writeOk) Log("reason=workspace_write_failed");
            else if (!desktopBlocked) Log("reason=desktop_readable_inside_container");
        }
        return 0;
    }

    private static string RunTool(string file, string arguments)
    {
        var info = new ProcessStartInfo
        {
            FileName = file,
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using (var process = Process.Start(info))
        {
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit(15000);
            return (stdout + " " + stderr).Trim();
        }
    }

    private static bool LaunchInAppContainer(
        IntPtr sid, string script, string workspace, out string error)
    {
        error = "";
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
        {
            error = "attribute_list_init:" + Marshal.GetLastWin32Error();
            return false;
        }

        var capabilities = new SECURITY_CAPABILITIES
        {
            AppContainerSid = sid,
            Capabilities = IntPtr.Zero,
            CapabilityCount = 0,
            Reserved = 0,
        };
        IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(capabilities, capsPtr, false);
        if (!UpdateProcThreadAttribute(
                list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                capsPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)),
                IntPtr.Zero, IntPtr.Zero))
        {
            error = "attribute_update:" + Marshal.GetLastWin32Error();
            return false;
        }

        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.lpAttributeList = list;

        string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(
            "$ProgressPreference='SilentlyContinue'; " + script));
        var commandLine = new StringBuilder(
            "\"powershell.exe\" -NoProfile -NonInteractive -EncodedCommand " + encoded);

        PROCESS_INFORMATION info;
        bool created = CreateProcessW(
            null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            IntPtr.Zero, workspace, ref startup, out info);
        if (!created)
        {
            error = "create_process:" + Marshal.GetLastWin32Error();
            return false;
        }

        WaitForSingleObject(info.hProcess, 30000);
        uint exitCode;
        GetExitCodeProcess(info.hProcess, out exitCode);
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        DeleteProcThreadAttributeList(list);
        Marshal.FreeHGlobal(list);
        Marshal.FreeHGlobal(capsPtr);
        return true;
    }
}
