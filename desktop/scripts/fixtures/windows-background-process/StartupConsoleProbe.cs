using System;
using System.Runtime.InteropServices;

// A disposable reg.exe stand-in. It never reads or writes the registry.
public static class StartupConsoleProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public UInt32 cb;
    public IntPtr reserved;
    public IntPtr desktop;
    public IntPtr title;
    public UInt32 x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public UInt16 showWindow, reservedBytes;
    public IntPtr reservedPointer, stdin, stdout, stderr;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern void GetStartupInfo(out StartupInfo info);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr handle);

  public static int Main(string[] args) {
    StartupInfo info;
    GetStartupInfo(out info);
    IntPtr console = GetConsoleWindow();
    Console.WriteLine("{\"hasConsole\":" + (console != IntPtr.Zero ? "true" : "false")
      + ",\"visible\":" + (console != IntPtr.Zero && IsWindowVisible(console) ? "true" : "false")
      + ",\"useShowWindow\":" + ((info.flags & 1) != 0 ? "true" : "false")
      + ",\"showWindow\":" + info.showWindow + "}");
    return 0;
  }
}
