Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c """ & root & "\启动embuddies.cmd"""
shell.Run command, 0, False
