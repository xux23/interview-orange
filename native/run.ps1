# 启动 Rust 原生壳（独立环境：工具链/产物都在项目内，不动系统）
# 用法：
#   powershell -ExecutionPolicy Bypass -File native\run.ps1
#   powershell -ExecutionPolicy Bypass -File native\run.ps1 -NoServer     # 服务已在跑
#   powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 1   # WDA 自检
param(
  [switch]$NoServer,
  [switch]$Build,
  [int]$SelfTest = 0,
  [int]$Port = 8756
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 1) 本地服务
function Test-Server {
  try { return (Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}
if (-not $NoServer -and -not (Test-Server)) {
  Write-Host '[run] 启动本地服务…'
  Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
}

# 2) 构建环境（仅本进程）
$tc = Join-Path $root '.tools\rustup\toolchains\stable-x86_64-pc-windows-gnu'
$lld = Join-Path $tc 'lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'
$env:RUSTUP_HOME = Join-Path $root '.tools\rustup'
$env:CARGO_HOME = Join-Path $root '.tools\cargo'
$env:CARGO_TARGET_DIR = 'D:\ml-build'
# dlltool/windres 需要可写 TEMP；受限环境下系统 Temp 可能拒绝访问
$tmpDir = Join-Path $root '.tmp-build'
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null }
$env:TMP = $tmpDir; $env:TEMP = $tmpDir
$env:PATH = "$(Join-Path $root '.tools\cargo\bin');$(Join-Path $tc 'bin');$(Join-Path $root '.tools\bin');$(Join-Path $root '.tools\binutils\mingw64\bin');$env:PATH"
$env:RUSTFLAGS = "-C linker=$lld -C linker-flavor=ld.lld -C link-self-contained=yes"

if ($Build) {
  Write-Host '[run] cargo build…'
  Push-Location (Join-Path $root 'native')
  & (Join-Path $root '.tools\cargo\bin\cargo.exe') build
  Pop-Location
}

# 3) 运行
$exe = 'D:\ml-build\debug\interview-orange.exe'
if (-not (Test-Path $exe)) { throw "未找到 $exe，请先加 -Build 构建" }
$loader = Get-ChildItem 'D:\ml-build\debug\build' -Recurse -Filter WebView2Loader.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like '*\x64\*' } | Select-Object -First 1
if ($loader) { Copy-Item $loader.FullName (Split-Path $exe) -Force }

if ($SelfTest -gt 0) { $env:ML_SELFTEST = "$SelfTest" } else { Remove-Item Env:\ML_SELFTEST -ErrorAction SilentlyContinue }

Write-Host "[run] 启动原生壳：$exe"
& $exe
