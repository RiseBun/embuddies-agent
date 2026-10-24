using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

// Runs only on a newly staged executable, before its release manifest is hashed.
public static class EmbuddiesIconResources
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    public static void SetIcon(string executable, string icon)
    {
        var data = File.ReadAllBytes(icon);
        using (var input = new BinaryReader(new MemoryStream(data)))
        using (var groupStream = new MemoryStream())
        using (var group = new BinaryWriter(groupStream))
        {
            if (input.ReadUInt16() != 0 || input.ReadUInt16() != 1) throw new InvalidDataException("Invalid ICO header");
            ushort count = input.ReadUInt16();
            if (count < 1 || count > 64) throw new InvalidDataException("Invalid ICO image count");
            group.Write((ushort)0); group.Write((ushort)1); group.Write(count);
            var images = new byte[count][];
            for (ushort i = 0; i < count; i++)
            {
                var dimensions = input.ReadBytes(8);
                uint length = input.ReadUInt32(), offset = input.ReadUInt32();
                if (dimensions.Length != 8 || length > data.Length || (ulong)offset + length > (ulong)data.Length)
                    throw new InvalidDataException("Invalid ICO image offset");
                images[i] = new byte[(int)length];
                Buffer.BlockCopy(data, (int)offset, images[i], 0, (int)length);
                group.Write(dimensions); group.Write(length); group.Write((ushort)(i + 1));
            }
            var update = BeginUpdateResource(executable, false);
            if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                foreach (ushort language in new ushort[] { 0, 1033 })
                {
                    for (int i = 0; i < images.Length; i++)
                        if (!UpdateResource(update, (IntPtr)3, (IntPtr)(i + 1), language, images[i], (uint)images[i].Length))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                    byte[] directory = groupStream.ToArray();
                    if (!UpdateResource(update, (IntPtr)14, (IntPtr)1, language, directory, (uint)directory.Length))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (!EndUpdateResource(update, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
                update = IntPtr.Zero;
            }
            finally { if (update != IntPtr.Zero) EndUpdateResource(update, true); }
        }
    }
}
