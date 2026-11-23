# 面试橙 · 便携启动器（双击 启动.bat 即可，无需安装任何东西）
# 桌面端 = Rust 原生壳（tao + wry，对齐原版技术栈）：
#   WDA 防截屏 / Ctrl+Alt+Esc panic / 窗口+进程伪装 / WASAPI 系统音频 / 焦点钩子 / 46 特性开关
# 用法：
#   .\启动.ps1            → Rust 原生壳（自动拉起本地服务）
#   .\启动.ps1 -Build     → 重新编译原生壳后启动
#   .\启动.ps1 -SelfTest 1→ WDA 防截屏自检（打印 PASS/FAIL）
#   .\启动.ps1 -Browser   → 仅浏览器模式（调试用；隐蔽与防检测在此模式全部不生效）
param(
  [switch]$Browser,
  [switch]$Build,
  [int]$SelfTest = 0
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$port = if ($env:ML_PORT) { $env:ML_PORT } else { 8756 }

# 1) 本地服务：没起就静默拉起（隐藏窗口）
function Test-Server {
  try { $r = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 2; return $r.ok } catch { return $false }
}
if (-not (Test-Server)) {
  Write-Host '[启动] 本地服务未运行，正在拉起…'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Error '未找到 Node.js（需要 >= 22.5）。整目录复制到新机器时先装 Node。'; exit 1 }
  Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Server) { break }
  }
  if (-not (Test-Server)) { Write-Error '服务启动失败，请手动执行 node server/index.js 查看报错'; exit 1 }
}
Write-Host "[启动] 本地服务就绪：http://127.0.0.1:$port （AI/ASR 按 .env 配置）"

# 2) 桌面壳：Rust 原生（唯一桌面路线）
if ($Browser) {
  Write-Host '[启动] 浏览器模式（注意：隐蔽与防检测在此模式全部不生效）'
  Start-Process "http://127.0.0.1:$port"
  return
}

$runArgs = @()
if ($Build) { $runArgs += '-Build' }
if ($SelfTest -gt 0) { $runArgs += "-SelfTest", "$SelfTest" }
Write-Host '[启动] Rust 原生壳（tao + wry）…'
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\native\run.ps1" -NoServer @runArgs
