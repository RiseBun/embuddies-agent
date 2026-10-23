import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let activePicker = null;

export function pickWindowsFolder() {
  if (process.platform !== "win32")
    return Promise.reject(new Error("文件夹选择仅支持 Windows"));
  if (activePicker) return activePicker;

  activePicker = execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='选择 embuddies 工作文件夹'; $dialog.ShowNewFolderButton=$true; if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.SelectedPath)}",
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 },
  )
    .then(({ stdout }) => stdout.trim())
    .finally(() => {
      activePicker = null;
    });
  return activePicker;
}
