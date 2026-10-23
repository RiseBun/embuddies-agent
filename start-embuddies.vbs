Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
script = "start-embuddies.ps1"
If WScript.Arguments.Named.Exists("candidate") Then script = "start-candidate.ps1"
If WScript.Arguments.Named.Exists("development") Then script = "start-development.ps1"
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\" & script & """"
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
    MsgBox "embuddies could not start: " & Err.Description, 16, "embuddies"
    WScript.Quit 1
End If
If result <> 0 Then
    MsgBox "embuddies could not start. Check the application files and the startup log in %LOCALAPPDATA%\embuddies\logs.", 16, "embuddies"
End If
WScript.Quit result
