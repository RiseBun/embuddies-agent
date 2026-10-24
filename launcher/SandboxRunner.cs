using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// embuddies sandbox runner.
//
// Modes:
//   token  -> write-restricted token (S-1-5-33) + Job Object, unelevated.
//             The child can read broadly but only write where *S-1-5-33 is granted.
//   job    -> Job Object only (resource limits, no write confinement).
//   auto   -> try token, fall back to job.
//
// Usage: sandbox-run.exe --workspace <dir> [--timeout <ms>] [--mode token|job|auto]
//                        --command <powershell command>
internal static class Program
{
    // --- token flags ---
    private const uint DISABLE_MAX_PRIVILEGE = 0x01;
    private const uint LUA_TOKEN = 0x04;
    private const uint WRITE_RESTRICTED = 0x08;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;

    // --- process creation ---
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    // --- job object ---
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    private const string WRITE_RESTRICTED_SID = "S-1-5-33";
    private const string SECRET_ENV_PATTERN =
        "API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|EMBUDDIES_";

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(
        IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingToken, uint flags,
        uint disableSidCount, IntPtr sidsToDisable,
        uint deletePrivilegeCount, IntPtr privilegesToDelete,
        uint restrictedSidCount, IntPtr sidsToRestrict,
        out IntPtr newToken);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUserW(
        IntPtr token, string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool InitializeAcl(IntPtr acl, int aclLength, int aclRevision);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AddAccessAllowedAce(
        IntPtr acl, int aclRevision, int accessMask, IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(
        IntPtr token, int infoClass, IntPtr info, int length);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetEntriesInAclW(
        uint count, IntPtr entries, IntPtr oldAcl, out IntPtr newAcl);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CopySid(
        uint length, IntPtr destination, IntPtr source);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetNamedSecurityInfoW(
        string objectName, int objectType, uint securityInfo,
        IntPtr owner, IntPtr group, out IntPtr dacl, out IntPtr sacl,
        out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetNamedSecurityInfoW(
        string objectName, int objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [StructLayout(LayoutKind.Sequential)]
    private struct TRUSTEE_W
    {
        public IntPtr pMultipleTrustee;
        public uint MultipleTrusteeOperation;
        public uint TrusteeForm;
        public uint TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EXPLICIT_ACCESS_W
    {
        public uint grfAccessPermissions;
        public uint grfAccessMode;
        public uint grfInheritance;
        public TRUSTEE_W Trustee;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_DEFAULT_DACL
    {
        public IntPtr DefaultDacl;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL
    {
        public SID_AND_ATTRIBUTES Label;
    }

    // Drop the child to Low integrity: it can still read, but writes are
    // blocked on Medium-integrity files (the user's documents/desktop).
    private static void SetLowIntegrity(IntPtr token)
    {
        IntPtr sid;
        if (!ConvertStringSidToSidW("S-1-16-4096", out sid))
            throw new InvalidOperationException(
                "ConvertStringSidToSid(low): " + Marshal.GetLastWin32Error());
        var label = new TOKEN_MANDATORY_LABEL
        {
            Label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 },
        };
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)));
        try
        {
            Marshal.StructureToPtr(label, buffer, false);
            if (!SetTokenInformation(token, 25, buffer,
                    Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL))))
                throw new InvalidOperationException(
                    "SetTokenInformation(integrity): " + Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);

    // Give the restricted token a default DACL the child itself can use.
    // Grants the token user SID and the write-restricted SID, so objects the
    // child creates (temp files, mutexes) stay writable by the child.
    private static void SetWriteRestrictedDefaultDacl(IntPtr token)
    {
        int length = 0;
        GetTokenInformation(token, 1, IntPtr.Zero, 0, out length);
        IntPtr userBuffer = Marshal.AllocHGlobal(length);
        GetTokenInformation(token, 1, userBuffer, length, out length);
        IntPtr userSid = Marshal.ReadIntPtr(userBuffer);

        IntPtr restrictedSid;
        if (!ConvertStringSidToSidW("S-1-5-33", out restrictedSid))
            throw new InvalidOperationException(
                "ConvertStringSidToSid: " + Marshal.GetLastWin32Error());
        int aclSize = 512;
        IntPtr acl = Marshal.AllocHGlobal(aclSize);
        if (!InitializeAcl(acl, aclSize, 2))
            throw new InvalidOperationException(
                "InitializeAcl: " + Marshal.GetLastWin32Error());
        if (!AddAccessAllowedAce(acl, 2, 0x10000000, userSid))
            throw new InvalidOperationException(
                "AddAccessAllowedAce(user): " + Marshal.GetLastWin32Error());
        if (!AddAccessAllowedAce(acl, 2, 0x10000000, restrictedSid))
            throw new InvalidOperationException(
                "AddAccessAllowedAce(restricted): " + Marshal.GetLastWin32Error());
        var dacl = new TOKEN_DEFAULT_DACL { DefaultDacl = acl };
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL)));
        try
        {
            Marshal.StructureToPtr(dacl, buffer, false);
            if (!SetTokenInformation(token, 6, buffer,
                    Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL))))
                throw new InvalidOperationException(
                    "SetTokenInformation: " + Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            Marshal.FreeHGlobal(acl);
            Marshal.FreeHGlobal(userBuffer);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe, out IntPtr writePipe, IntPtr attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr handle, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

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
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                "sandbox-run failed: " + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        string workspace = null;
        string command = null;
        string mode = "auto";
        string capabilitySid = null;
        string tempDir = null;
        int timeoutMs = 120000;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--workspace" && i + 1 < args.Length) workspace = args[++i];
            else if (args[i] == "--command" && i + 1 < args.Length) command = args[++i];
            else if (args[i] == "--mode" && i + 1 < args.Length) mode = args[++i];
            else if (args[i] == "--capability-sid" && i + 1 < args.Length) capabilitySid = args[++i];
            else if (args[i] == "--temp-dir" && i + 1 < args.Length) tempDir = args[++i];
            else if (args[i] == "--timeout" && i + 1 < args.Length)
                int.TryParse(args[++i], out timeoutMs);
        }
        if (string.IsNullOrEmpty(command))
        {
            Console.Error.WriteLine(
                "usage: sandbox-run.exe --workspace <dir> [--timeout <ms>] [--mode token|job|auto] --command <powershell command>");
            return 2;
        }
        if (string.IsNullOrEmpty(workspace) || !Directory.Exists(workspace))
        {
            Console.Error.WriteLine("workspace does not exist: " + workspace);
            return 2;
        }

        string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(
            "$ProgressPreference = 'SilentlyContinue'; " + command));

        if (mode == "write")
        {
            try
            {
                return RunWithToken(
                    workspace, encoded, timeoutMs, false, capabilitySid, true,
                    tempDir);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("write_mode_failed: " + error.Message);
                return 3;
            }
        }
        if (mode == "low")
        {
            try
            {
                return RunWithToken(
                    workspace, encoded, timeoutMs, true, capabilitySid, true,
                    tempDir);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("low_mode_failed: " + error.Message);
                return 3;
            }
        }
        if (mode == "token" || mode == "auto")
        {
            try
            {
                return RunWithToken(
                    workspace, encoded, timeoutMs, false, null, false, null);
            }
            catch (Exception error)
            {
                if (mode == "token")
                {
                    Console.Error.WriteLine("token_mode_failed: " + error.Message);
                    return 3;
                }
                Console.Error.WriteLine(
                    "token_mode_fallback: " + error.Message);
            }
        }
        return RunWithJob(workspace, command, timeoutMs);
    }

    // ---------------------------------------------------------------- token

    private static IntPtr ResolveSid(string sddl)
    {
        IntPtr sid;
        if (!ConvertStringSidToSidW(sddl, out sid))
            throw new InvalidOperationException(
                "ConvertStringSidToSid(" + sddl + "): " + Marshal.GetLastWin32Error());
        return sid;
    }

    // The logon SID (SE_GROUP_LOGON_ID) must be in the restricting list and the
    // default DACL, or early DLL init fails with 0xC0000142.
    private static IntPtr GetLogonSid(IntPtr token)
    {
        int length = 0;
        GetTokenInformation(token, 2, IntPtr.Zero, 0, out length);
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, 2, buffer, length, out length))
                throw new InvalidOperationException(
                    "GetTokenInformation(TokenGroups): " + Marshal.GetLastWin32Error());
            int count = Marshal.ReadInt32(buffer);
            long baseAddress = buffer.ToInt64() + 8;
            for (int i = 0; i < count; i++)
            {
                long entry = baseAddress + i * 16;
                IntPtr sid = Marshal.ReadIntPtr(new IntPtr(entry));
                uint attributes = (uint)Marshal.ReadInt32(new IntPtr(entry + 8));
                if ((attributes & 0xC0000000) != 0xC0000000) continue;
                uint sidLength = GetLengthSid(sid);
                IntPtr copy = Marshal.AllocHGlobal((int)sidLength);
                if (!CopySid(sidLength, copy, sid))
                {
                    Marshal.FreeHGlobal(copy);
                    throw new InvalidOperationException(
                        "CopySid: " + Marshal.GetLastWin32Error());
                }
                return copy;
            }
            throw new InvalidOperationException("logon SID not found");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static IntPtr BuildRestrictingSids(IntPtr[] sids)
    {
        IntPtr buffer = Marshal.AllocHGlobal(16 * sids.Length);
        for (int i = 0; i < sids.Length; i++)
        {
            long entry = buffer.ToInt64() + i * 16;
            Marshal.WriteIntPtr(new IntPtr(entry), sids[i]);
            Marshal.WriteInt32(new IntPtr(entry + 8), 0);
            Marshal.WriteInt32(new IntPtr(entry + 12), 0);
        }
        return buffer;
    }

    // Merged default DACL: objects the child creates must stay usable by the
    // same SIDs carried in the restricting list.
    // DSH-style capability SID: S-1-4-<sha256(path)[0..4]>(2^30-1)+1>-<...>.
    private static string DeriveWorkspaceSid(string workspace)
    {
        using (var sha = System.Security.Cryptography.SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(workspace));
            const uint modulus = 0x3FFFFFFF; // 2^30 - 1
            uint a = (uint)(BitConverter.ToUInt32(digest, 0) & 0xFFFFFFFF) % modulus + 1;
            uint b = (uint)(BitConverter.ToUInt32(digest, 4) & 0xFFFFFFFF) % modulus + 1;
            return "S-1-4-" + a + "-" + b;
        }
    }

    // Private temp capability: domain-separated from the workspace SID with a
    // fixed third subauthority, like DSH's tempWriteSid.
    private static string DeriveTempSid(string tempDir)
    {
        using (var sha = System.Security.Cryptography.SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(
                Encoding.UTF8.GetBytes("temp\0" + tempDir));
            const uint modulus = 0x3FFFFFFF;
            uint a = BitConverter.ToUInt32(digest, 0) % modulus + 1;
            uint b = BitConverter.ToUInt32(digest, 4) % modulus + 1;
            return "S-1-4-" + a + "-" + b + "-1";
        }
    }

    // Grant the workspace to the capability SID (write/delete, but not
    // WRITE_DAC/WRITE_OWNER) so the WRITE_RESTRICTED child can write it.
    private static void GrantCapability(string path, IntPtr sid)
    {
        IntPtr oldDacl, oldSacl, descriptor;
        uint read = GetNamedSecurityInfoW(
            path, 1, 4, IntPtr.Zero, IntPtr.Zero,
            out oldDacl, out oldSacl, out descriptor);
        if (read != 0)
            throw new InvalidOperationException(
                "GetNamedSecurityInfoW(" + path + "): " + read);
        int size = Marshal.SizeOf(typeof(EXPLICIT_ACCESS_W));
        IntPtr entries = Marshal.AllocHGlobal(size);
        try
        {
            var entry = new EXPLICIT_ACCESS_W
            {
                grfAccessPermissions = 1114454,
                grfAccessMode = 1, // GRANT_ACCESS
                grfInheritance = 3, // OI | CI
                Trustee = new TRUSTEE_W
                {
                    MultipleTrusteeOperation = 0,
                    TrusteeForm = 0,
                    TrusteeType = 0,
                    ptstrName = sid,
                },
            };
            Marshal.StructureToPtr(entry, entries, false);
            IntPtr newDacl;
            uint merge = SetEntriesInAclW(1, entries, oldDacl, out newDacl);
            if (merge != 0)
                throw new InvalidOperationException(
                    "SetEntriesInAclW(" + path + "): " + merge);
            try
            {
                uint apply = SetNamedSecurityInfoW(
                    path, 1, 4, IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
                if (apply != 0)
                    throw new InvalidOperationException(
                        "SetNamedSecurityInfoW(" + path + "): " + apply);
            }
            finally
            {
                LocalFree(newDacl);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(entries);
            LocalFree(descriptor);
        }
    }

    private static void SetMergedDefaultDacl(IntPtr token, IntPtr[] sids)
    {
        int size = Marshal.SizeOf(typeof(EXPLICIT_ACCESS_W));
        IntPtr entries = Marshal.AllocHGlobal(size * sids.Length);
        try
        {
            for (int i = 0; i < sids.Length; i++)
            {
                var entry = new EXPLICIT_ACCESS_W
                {
                    grfAccessPermissions = 2032127, // FILE_ALL_ACCESS
                    grfAccessMode = 1, // GRANT_ACCESS
                    grfInheritance = 0,
                    Trustee = new TRUSTEE_W
                    {
                        pMultipleTrustee = IntPtr.Zero,
                        MultipleTrusteeOperation = 0,
                        TrusteeForm = 0, // TRUSTEE_IS_SID
                        TrusteeType = 0,
                        ptstrName = sids[i],
                    },
                };
                Marshal.StructureToPtr(
                    entry, new IntPtr(entries.ToInt64() + i * size), false);
            }
            IntPtr newAcl;
            // "Merged" means merge with the token's EXISTING default DACL, not
            // replace it, or the child cannot access objects it creates.
            IntPtr infoBuffer = IntPtr.Zero;
            IntPtr oldAcl = IntPtr.Zero;
            try
            {
                int infoLength = 0;
                GetTokenInformation(token, 6, IntPtr.Zero, 0, out infoLength);
                infoBuffer = Marshal.AllocHGlobal(infoLength);
                if (!GetTokenInformation(token, 6, infoBuffer, infoLength, out infoLength))
                    throw new InvalidOperationException(
                        "GetTokenInformation(defaultDacl): " +
                        Marshal.GetLastWin32Error());
                oldAcl = Marshal.ReadIntPtr(infoBuffer);
                uint result = SetEntriesInAclW(
                    (uint)sids.Length, entries, oldAcl, out newAcl);
                if (result != 0)
                    throw new InvalidOperationException(
                        "SetEntriesInAclW(defaultDacl): " + result);
            }
            finally
            {
                if (infoBuffer != IntPtr.Zero) Marshal.FreeHGlobal(infoBuffer);
            }
            try
            {
                IntPtr info = Marshal.AllocHGlobal(8);
                try
                {
                    Marshal.WriteIntPtr(info, newAcl);
                    if (!SetTokenInformation(token, 6, info, 8))
                        throw new InvalidOperationException(
                            "SetTokenInformation(defaultDacl): " +
                            Marshal.GetLastWin32Error());
                }
                finally
                {
                    Marshal.FreeHGlobal(info);
                }
            }
            finally
            {
                LocalFree(newAcl);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(entries);
        }
    }

    private static int RunWithToken(
        string workspace, string encoded, int timeoutMs,
        bool lowIntegrity, string capabilitySid, bool writeRestricted,
        string tempDir)
    {
        IntPtr baseToken;
        if (!OpenProcessToken(GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY |
                TOKEN_ADJUST_DEFAULT, out baseToken))
            throw new InvalidOperationException(
                "OpenProcessToken: " + Marshal.GetLastWin32Error());
        IntPtr restricted;
        uint tokenFlags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN;
        if (writeRestricted) tokenFlags |= WRITE_RESTRICTED;
        string overrideFlags = Environment.GetEnvironmentVariable("EMBUDDIES_SANDBOX_FLAGS");
        uint parsedFlags;
        if (uint.TryParse(overrideFlags, out parsedFlags))
            tokenFlags = parsedFlags;
        IntPtr everyone = ResolveSid("S-1-1-0");
        IntPtr logon = GetLogonSid(baseToken);
        IntPtr workspaceSid = IntPtr.Zero;
        IntPtr tempSid = IntPtr.Zero;
        if (writeRestricted)
        {
            if (!string.IsNullOrEmpty(capabilitySid))
                workspaceSid = ResolveSid(capabilitySid);
            else
            {
                workspaceSid = ResolveSid(DeriveWorkspaceSid(workspace));
                GrantCapability(workspace, workspaceSid);
            }
            if (!string.IsNullOrEmpty(tempDir))
            {
                tempSid = ResolveSid(DeriveTempSid(tempDir));
                GrantCapability(tempDir, tempSid);
            }
        }
        IntPtr[] restricting = writeRestricted
            ? (tempSid != IntPtr.Zero
                ? new[] { logon, everyone, workspaceSid, tempSid }
                : new[] { logon, everyone, workspaceSid })
            : new IntPtr[0];
        IntPtr restrictingBuffer = restricting.Length > 0
            ? BuildRestrictingSids(restricting)
            : IntPtr.Zero;
        try
        {
            if (!CreateRestrictedToken(baseToken,
                    tokenFlags,
                    0, IntPtr.Zero, 0, IntPtr.Zero,
                    (uint)restricting.Length, restrictingBuffer, out restricted))
                throw new InvalidOperationException(
                    "CreateRestrictedToken: " + Marshal.GetLastWin32Error());
        }
        finally
        {
            if (restrictingBuffer != IntPtr.Zero)
                Marshal.FreeHGlobal(restrictingBuffer);
        }
        CloseHandle(baseToken);

        if (writeRestricted &&
            Environment.GetEnvironmentVariable("EMBUDDIES_SANDBOX_MERGE_DACL") != "0")
            SetMergedDefaultDacl(restricted, restricting);
        if (lowIntegrity ||
            Environment.GetEnvironmentVariable("EMBUDDIES_SANDBOX_LOW_INTEGRITY") == "1")
        {
            SetLowIntegrity(restricted);
        }

        IntPtr readPipe, writePipe;
        if (!CreatePipe(out readPipe, out writePipe, IntPtr.Zero, 0))
            throw new InvalidOperationException(
                "CreatePipe: " + Marshal.GetLastWin32Error());
        SetHandleInformation(writePipe, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        var startup = new STARTUPINFO
        {
            cb = Marshal.SizeOf(typeof(STARTUPINFO)),
            dwFlags = STARTF_USESTDHANDLES,
            hStdOutput = writePipe,
            hStdError = writePipe,
        };
        var commandLine = new StringBuilder(
            "\"powershell.exe\" -NoProfile -NonInteractive -EncodedCommand " + encoded);
        IntPtr environment = BuildEnvironment(tempDir);
        PROCESS_INFORMATION info;
        bool created = CreateProcessAsUserW(
            restricted, null, commandLine,
            IntPtr.Zero, IntPtr.Zero, true,
            CREATE_UNICODE_ENVIRONMENT,
            environment, workspace, ref startup, out info);
        Marshal.FreeHGlobal(environment);
        CloseHandle(writePipe);
        if (!created)
        {
            CloseHandle(readPipe);
            CloseHandle(restricted);
            throw new InvalidOperationException(
                "CreateProcessAsUser: " + Marshal.GetLastWin32Error());
        }

        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateJob(512L * 1024 * 1024, 32);
            AssignProcessToJobObject(job, info.hProcess);
        }
        catch
        {
            // Resource limits are best effort in token mode.
        }

        var outputHolder = new StringBuilder();
        var reader = new Thread(() =>
        {
            var buffer = new byte[4096];
            uint read;
            while (ReadFile(readPipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero) &&
                   read > 0)
                outputHolder.Append(Encoding.UTF8.GetString(buffer, 0, (int)read));
        });
        reader.IsBackground = true;
        reader.Start();

        bool exited = WaitForSingleObject(info.hProcess, (uint)timeoutMs) == 0;
        uint exitCode = 0;
        if (!exited)
        {
            TerminateProcess(info.hProcess, 124);
            exitCode = 124;
            reader.Join(3000);
        }
        else
        {
            reader.Join(5000);
            GetExitCodeProcess(info.hProcess, out exitCode);
        }
        CloseHandle(readPipe);
        string output = outputHolder.ToString();
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        CloseHandle(restricted);
        if (job != IntPtr.Zero) CloseHandle(job);

        if (output.Length > 0) Console.Out.Write(output);
        if (!exited)
        {
            Console.Error.WriteLine("command timed out after " + timeoutMs + "ms");
            return 124;
        }
        return (int)exitCode;
    }

    private static void GrantWriteRestricted(string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        string args = "\"" + path + "\" /grant *" + WRITE_RESTRICTED_SID +
                      ":(OI)(CI)(W) /Q /C";
        try
        {
            var info = new ProcessStartInfo
            {
                FileName = "icacls",
                Arguments = args,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var process = Process.Start(info))
            {
                process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
                process.WaitForExit(15000);
            }
        }
        catch
        {
            // Grant is best effort; failures show up as child write errors.
        }
    }

    private static IntPtr BuildEnvironment(string tempDir = null)
    {
        var entries = new System.Collections.Generic.List<string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string key = (string)entry.Key;
            if (Regex.IsMatch(key, SECRET_ENV_PATTERN, RegexOptions.IgnoreCase))
                continue;
            if (tempDir != null &&
                (key.Equals("TEMP", StringComparison.OrdinalIgnoreCase) ||
                 key.Equals("TMP", StringComparison.OrdinalIgnoreCase)))
                continue;
            entries.Add(key + "=" + (string)entry.Value);
        }
        if (tempDir != null)
        {
            entries.Add("TEMP=" + tempDir);
            entries.Add("TMP=" + tempDir);
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        var builder = new StringBuilder();
        foreach (string line in entries) builder.Append(line).Append('\0');
        builder.Append('\0');
        return Marshal.StringToHGlobalUni(builder.ToString());
    }

    // ------------------------------------------------------------------ job

    private static int RunWithJob(string workspace, string command, int timeoutMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -NonInteractive -EncodedCommand " +
                Convert.ToBase64String(Encoding.Unicode.GetBytes(
                    "$ProgressPreference = 'SilentlyContinue'; " + command)),
            WorkingDirectory = workspace,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        using (var process = new Process { StartInfo = psi })
        {
            if (!process.Start())
            {
                Console.Error.WriteLine("failed to start command");
                return 2;
            }
            IntPtr job = IntPtr.Zero;
            try
            {
                job = CreateJob(512L * 1024 * 1024, 32);
                AssignProcessToJobObject(job, process.Handle);

                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    Console.Error.WriteLine("command timed out after " + timeoutMs + "ms");
                    Console.Out.Write(stdout.Result);
                    Console.Error.Write(stderr.Result);
                    return 124;
                }
                Console.Out.Write(stdout.Result);
                Console.Error.Write(stderr.Result);
                return process.ExitCode;
            }
            finally
            {
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }
    }

    private static IntPtr CreateJob(long maxMemoryBytes, uint maxProcesses)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new InvalidOperationException(
                "CreateJobObject failed: " + Marshal.GetLastWin32Error());
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_PROCESS_MEMORY |
            JOB_OBJECT_LIMIT_JOB_MEMORY |
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        limits.BasicLimitInformation.ActiveProcessLimit = maxProcesses;
        limits.ProcessMemoryLimit = (UIntPtr)(ulong)maxMemoryBytes;
        limits.JobMemoryLimit = (UIntPtr)(ulong)maxMemoryBytes;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                    buffer, (uint)size))
                throw new InvalidOperationException(
                    "SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }
}
