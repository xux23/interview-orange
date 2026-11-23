<#
 * 桌面壳（不依赖 Electron）：用 Chromium 系浏览器（Edge/Chrome）的 --app 模式开窗，
 * 再用 Win32 API 把浮窗钉成「置顶 + 不进任务栏 + 半透明」，等价于 Tauri 的
 * transparent / alwaysOnTop / skipTaskbar 三件套。
 *
 * 用法：
 *   powershell -ExecutionPolicy Bypass -File shell\launch.ps1
 *   powershell -ExecutionPolicy Bypass -File shell\launch.ps1 -Base http://127.0.0.1:8756 -OverlayAlpha 220
#>
param(
  [string]$Base = 'http://127.0.0.1:8756',
  [int]$MainWidth = 1280,
  [int]$MainHeight = 860,
  [int]$OverlayWidth = 420,
  [int]$OverlayHeight = 640,
  [int]$OverlayAlpha = 235,
  [switch]$NoOverlay
)

$ErrorActionPreference = 'Stop'

function Find-Browser {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    ('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    ('C:\Program Files (x86)\Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw '未找到 Edge/Chrome：请安装 Chromium 系浏览器，或改用浏览器直接访问。'
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Shell {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00400000;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
  public const uint LWA_ALPHA = 0x2;
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint color, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@

function Wait-Window([string]$title, [int]$timeoutMs = 15000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $h = [Win32Shell]::FindWindow($null, $title)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}

$browser = Find-Browser
$profile = Join-Path $PSScriptRoot '.profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$common = @("--user-data-dir=$profile", '--no-first-run', '--no-default-browser-check', '--disable-features=EdgeSidebar')

# 主工作台窗口
Start-Process -FilePath $browser -ArgumentList (@(
  "--app=$Base/#main", "--window-size=$MainWidth,$MainHeight", "--window-position=40,40"
) + $common) | Out-Null
$mainHwnd = Wait-Window '面试橙 · 工作台'
if ($mainHwnd -ne [IntPtr]::Zero) {
  [Win32Shell]::SetWindowPos($mainHwnd, [Win32Shell]::HWND_TOPMOST, 0, 0, $MainWidth, $MainHeight, 0x0010 -bor 0x0002) | Out-Null
  [Win32Shell]::SetWindowPos($mainHwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
  Write-Host '[shell] 主窗已就绪'
} else {
  Write-Warning '[shell] 主窗未找到（可能被浏览器复用），继续启动浮窗'
}

if ($NoOverlay) { Write-Host '[shell] 跳过浮窗（-NoOverlay）'; exit 0 }

# 浮窗：独立 app 窗口 → 置顶 + 工具窗口（不进任务栏）+ 整窗 alpha
$x = [Math]::Max(0, (Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentHorizontalResolution - $OverlayWidth - 24)
Start-Process -FilePath $browser -ArgumentList (@(
  "--app=$Base/#overlay", "--window-size=$OverlayWidth,$OverlayHeight", "--window-position=$($x),60"
) + $common) | Out-Null
$ovHwnd = Wait-Window '面试橙 · 浮窗'
if ($ovHwnd -ne [IntPtr]::Zero) {
  $ex = [Win32Shell]::GetWindowLong($ovHwnd, [Win32Shell]::GWL_EXSTYLE)
  $ex = ($ex -bor [Win32Shell]::WS_EX_TOOLWINDOW) -band (-bnot [Win32Shell]::WS_EX_APPWINDOW)
  [Win32Shell]::SetWindowLong($ovHwnd, [Win32Shell]::GWL_EXSTYLE, $ex) | Out-Null
  [Win32Shell]::SetWindowPos($ovHwnd, [Win32Shell]::HWND_TOPMOST, $x, 60, $OverlayWidth, $OverlayHeight, 0x0010) | Out-Null
  [Win32Shell]::SetLayeredWindowAttributes($ovHwnd, 0, [byte]$OverlayAlpha, [Win32Shell]::LWA_ALPHA) | Out-Null
  Write-Host "[shell] 浮窗已就绪：topmost / toolwindow / alpha=$OverlayAlpha"
} else {
  Write-Warning '[shell] 浮窗句柄未找到；可在浏览器内手动拖到目标位置'
}
Write-Host "[shell] 完成。运维命令：shell\overlay-toggle.ps1 -Hide / -Show"
