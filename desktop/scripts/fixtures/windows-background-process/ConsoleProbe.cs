using System;
using System.Runtime.InteropServices;

public static class ConsoleProbe {
  [DllImport("kernel32.dll")]
  static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AllocConsole();
  [DllImport("kernel32.dll")]
  static extern bool FreeConsole();
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr handle, int command);

  public static int Main(string[] args) {
    var output = Console.Out;
    bool explicitControl = Array.IndexOf(args, "--allocate-console") >= 0;
    bool allocated = false;
    int allocationError = 0;
    if (explicitControl) {
      // A runner may inherit an invisible console; AllocConsole fails if still attached.
      FreeConsole();
      allocated = AllocConsole();
      allocationError = allocated ? 0 : Marshal.GetLastWin32Error();
      ShowWindow(GetConsoleWindow(), 5);
      System.Threading.Thread.Sleep(150);
    }
    IntPtr handle = GetConsoleWindow();
    output.WriteLine("{\"hasConsole\":" + (handle != IntPtr.Zero ? "true" : "false")
      + ",\"visible\":" + (handle != IntPtr.Zero && IsWindowVisible(handle) ? "true" : "false")
      + ",\"allocated\":" + (allocated ? "true" : "false")
      + ",\"allocationError\":" + allocationError + "}");
    Console.Error.WriteLine("fixture-stderr");
    if (explicitControl) FreeConsole();
    return Array.IndexOf(args, "--fail") >= 0 ? 7 : 0;
  }
}
