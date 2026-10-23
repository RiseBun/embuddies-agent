[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$env:EMBUDDIES_TEST_DIALOG_PID)
$window=$null
for($attempt=0;$attempt -lt 40;$attempt++){
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  foreach($candidateWindow in $windows){
    if($candidateWindow.Current.ClassName -eq '#32770'){$window=$candidateWindow;break}
    $dialogCondition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')
    $nested=$candidateWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$dialogCondition)
    if($nested){$window=$nested;break}
  }
  if($window){break}
  Start-Sleep -Milliseconds 250
}
if(-not $window){$windows | ForEach-Object {$_.Current.Name+' '+$_.Current.ClassName} | Write-Output;throw 'Native folder dialog missing'}
Add-Type @'
using System;using System.Runtime.InteropServices;
public class NativeDialogProbe {
public delegate bool EnumCallback(IntPtr w,IntPtr p);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr w,EnumCallback c,IntPtr p);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr w,System.Text.StringBuilder b,int n);
[DllImport("user32.dll")]public static extern int GetDlgCtrlID(IntPtr w);
public static IntPtr Edit(IntPtr w){IntPtr first=IntPtr.Zero,match=IntPtr.Zero;EnumChildWindows(w,(h,p)=>{var b=new System.Text.StringBuilder(256);GetClassName(h,b,256);if(b.ToString()=="Edit"){if(first==IntPtr.Zero)first=h;if(GetDlgCtrlID(h)==1148)match=h;}return true;},IntPtr.Zero);return match!=IntPtr.Zero?match:first;}
public static IntPtr Button(IntPtr w){IntPtr match=IntPtr.Zero;EnumChildWindows(w,(h,p)=>{var b=new System.Text.StringBuilder(256);GetClassName(h,b,256);if(b.ToString()=="Button"&&GetDlgCtrlID(h)==1)match=h;return true;},IntPtr.Zero);return match;}
[DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr w,int id);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string c,string n);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr w,uint m,IntPtr p,string s);
[DllImport("user32.dll",EntryPoint="SendMessageW")]public static extern IntPtr SendCommand(IntPtr w,uint m,IntPtr p,IntPtr s);
}
'@
$handle=[IntPtr]$window.Current.NativeWindowHandle
$edit=[NativeDialogProbe]::Edit($handle)
if($edit -eq [IntPtr]::Zero){throw 'Native filename edit missing'}
[void][NativeDialogProbe]::SendMessage($edit,12,[IntPtr]::Zero,$env:EMBUDDIES_TEST_FOLDER)
$button=[NativeDialogProbe]::Button($handle)
if($button -eq [IntPtr]::Zero){throw 'Native selection button missing'}
[void][NativeDialogProbe]::SendCommand($button,245,[IntPtr]::Zero,[IntPtr]::Zero)
