$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class EmbuddiesResizeProbe {
 public static bool PhysicalDrag = false;
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int L,T,R,B;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int attr,out Rect r,int size);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] public static extern int Cloaked(IntPtr h,int attr,out int value,int size);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 public static int[] Check(long value) {
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  IntPtr h=new IntPtr(value); SetWindowPos(h,new IntPtr(-1),0,0,0,0,0x0043); SetForegroundWindow(h); Thread.Sleep(250); var hits=new int[8];
  for(int i=0;i<8;i++) {
   Rect r, visible; GetWindowRect(h,out r);
   if(DwmGetWindowAttribute(h,9,out visible,Marshal.SizeOf(typeof(Rect)))!=0)visible=r;
   int midX=(visible.L+visible.R)/2, midY=(visible.T+visible.B)/2;
   int x=i==0||i==4||i==6?visible.L:i==1||i==5||i==7?visible.R-1:midX;
   int y=i==2||i==4||i==5?visible.T+1:i==3||i==6||i==7?visible.B-1:midY;
   IntPtr point=new IntPtr((long)((uint)(x&65535)|((uint)(y&65535)<<16)));
   hits[i]=SendMessage(h,0x84,IntPtr.Zero,point).ToInt32();
   if(hits[i]<10||hits[i]>17) {
    string scan="";
    for(int xx=r.L-2;xx<=visible.L+10;xx++) {
     IntPtr p=new IntPtr((long)((uint)(xx&65535)|((uint)(y&65535)<<16)));
     scan+=xx+":"+SendMessage(h,0x84,IntPtr.Zero,p)+":"+GetAncestor(WindowFromPoint(new Point{X=xx,Y=y}),2)+",";
    }
    throw new Exception("Missing native resize edge "+i+"; hit="+hits[i]+"; target="+h+"; rect="+r.L+","+r.T+","+r.R+","+r.B+"; visible="+visible.L+","+visible.T+","+visible.R+","+visible.B+"; scan="+scan);
   }
   if(!PhysicalDrag)continue;
   SetCursorPos(x,y); Thread.Sleep(80); mouse_event(2,0,0,0,UIntPtr.Zero); Thread.Sleep(60);
   int dx=i==0||i==4||i==6?-18:i==1||i==5||i==7?18:0;
   int dy=i==2||i==4||i==5?-18:i==3||i==6||i==7?18:0;
   SetCursorPos(x+dx,y+dy); Thread.Sleep(100); mouse_event(4,0,0,0,UIntPtr.Zero); Thread.Sleep(120);
   Rect after; GetWindowRect(h,out after);
   if(after.R-after.L==r.R-r.L&&after.B-after.T==r.B-r.T) { int cloaked; Cloaked(h,14,out cloaked,4);throw new Exception("Resize drag did not change edge "+i+"; visible="+IsWindowVisible(h)+"; cloaked="+cloaked+"; target="+h+"; foreground="+GetForegroundWindow()+"; underPointer="+GetAncestor(WindowFromPoint(new Point{X=x,Y=y}),2)+"; point="+x+","+y); }
  }
  return hits;
 }
}
'@
[EmbuddiesResizeProbe]::PhysicalDrag=$env:EMBUDDIES_PHYSICAL_DRAG -eq '1'
[EmbuddiesResizeProbe]::Check([long]$env:EMBUDDIES_TEST_WINDOW_HANDLE)|ConvertTo-Json -Compress
