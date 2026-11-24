<#
 * 浮窗显示/隐藏（panic 等价物）：主窗崩溃或需要紧急隐藏时用。
 *   powershell -File shell\overlay-toggle.ps1 -Hide
 *   powershell -File shell\overlay-toggle.ps1 -Show
#>
param([switch]$Hide, [switch]$Show)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Toggle {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
}
'@

$h = [Win32Toggle]::FindWindow($null, '面试橙 · 浮窗')
if ($h -eq [IntPtr]::Zero) { Write-Warning '浮窗未运行'; exit 1 }

if ($Hide -or (-not $Show)) {
  [Win32Toggle]::ShowWindow($h, 0) | Out-Null      # SW_HIDE
  Write-Host '[shell] 浮窗已隐藏'
} else {
  [Win32Toggle]::ShowWindow($h, 4) | Out-Null      # SW_SHOWNOACTIVATE
  [Win32Toggle]::SetWindowPos($h, [Win32Toggle]::HWND_TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
  Write-Host '[shell] 浮窗已显示（topmost，不抢焦点）'
}
