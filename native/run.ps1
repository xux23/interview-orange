# 启动 Rust 原生壳（独立环境：工具链/产物都在项目内，不动系统）
# 用法：
#   powershell -ExecutionPolicy Bypass -File native\run.ps1
#   powershell -ExecutionPolicy Bypass -File native\run.ps1 -NoServer     # 服务已在跑
#   powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 1   # WDA 自检
param(
  [switch]$NoServer,
  [switch]$Build,
  [switch]$BuildOnly,
  [switch]$Release,
  [int]$SelfTest = 0,
  [int]$Port = 8756
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $env:ML_DATA_DIR) { $env:ML_DATA_DIR = Join-Path $root 'data' }
# 端口优先级：-Port 参数 > 已有 ML_PORT 环境变量 > .env 的 ML_PORT > 默认 8756。
# 先行注入 ML_PORT：自动拉起的 node 服务与原生壳都用它（否则非默认端口时两边脱节）。
if ($PSBoundParameters.ContainsKey('Port')) {
  $env:ML_PORT = "$Port"
} elseif (-not $env:ML_PORT) {
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*ML_PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $env:ML_PORT = $m.Matches[0].Groups[1].Value }
  }
  if (-not $env:ML_PORT) { $env:ML_PORT = '8756' }
}
$Port = [int]$env:ML_PORT

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
$cargo = Join-Path $root '.tools\cargo\bin\cargo.exe'
if (-not (Test-Path $cargo)) {
  throw @(
    "[run] 未找到 Rust 工具链：$cargo",
    "      .tools/ 目录不存在（可能已被 restore -Full 清除），当前无法构建/运行原生壳。",
    "      服务与浏览器模式不受影响（node server/index.js / 启动.ps1 -Browser）；",
    "      需要原生壳能力（防截屏/热键/伪装）时，按 RUN.md 重建 .tools 工具链后重试。"
  ) -join "`n"
}
$tc = Join-Path $root '.tools\rustup\toolchains\stable-x86_64-pc-windows-gnu'
$lld = Join-Path $tc 'lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'
$env:RUSTUP_HOME = Join-Path $root '.tools\rustup'
$env:CARGO_HOME = Join-Path $root '.tools\cargo'

# 构建路径策略（不再硬编码任何盘符）：
#   - 项目路径为纯 ASCII → 直接用项目内真实路径，零外部痕迹
#   - 含非 ASCII → 在任一可用盘符根创建/复用 ASCII junction `<盘符>:\ml-src → <项目根>`，
#     产物目录（CARGO_TARGET_DIR）与 TMP 都经它变成 ASCII（物理文件仍在项目内，随目录搬迁）；
#     同时导出 ML_REAL_ROOT / ML_ASCII_ROOT 供 .tools\bin\gcc.exe 改写 shim 使用
#     （windres 的 gcc -E 预处理输出里烙有 CARGO_MANIFEST_DIR 真实路径，shim 把它改写成 junction 路径）
function Resolve-AsciiRoot {
  param([string]$Root)
  if ($Root -notmatch '[^\x20-\x7E]') { return $Root }
  $drives = Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root }
  # 先复用已指向本项目根的 junction（搬迁后旧 junction 指向别处/已失效则不算；
  # 注意失效 junction 的 Test-Path 为 false，须用 Get-Item -Force 探测 reparse point）
  foreach ($d in $drives) {
    $j = "$($d)ml-src"
    $it = Get-Item $j -Force -ErrorAction SilentlyContinue
    if ($it -and $it.LinkType -eq 'Junction' -and $it.Target -eq $Root -and (Test-Path $j)) { return $j }
  }
  # 否则在第一个可用盘符根创建（ml-src 名下的旧/失效 junction 安全重建，真实目录不动）
  foreach ($d in $drives) {
    $j = "$($d)ml-src"
    $it = Get-Item $j -Force -ErrorAction SilentlyContinue
    if ($it -and $it.LinkType -ne 'Junction') { continue }   # 真实目录/文件：不碰
    try {
      if ($it) { Remove-Item $j -Force -ErrorAction Stop }
      New-Item -ItemType Junction -Path $j -Target $Root -ErrorAction Stop | Out-Null
      if ($it) { Write-Host "[run] 已重建 ASCII junction：$j → $Root" }
      else { Write-Host "[run] 已创建 ASCII junction：$j → $Root（卸载时删除该 junction 即可，物理文件在项目内）" }
      return $j
    } catch { continue }
  }
  throw "项目路径含非 ASCII 字符，且无法在任何盘符根创建 ASCII junction。请把项目移到纯英文路径后重试。"
}
$asciiRoot = Resolve-AsciiRoot $root
$env:CARGO_TARGET_DIR = Join-Path $asciiRoot '.tools\target'
if ($asciiRoot -ne $root) {
  $env:ML_REAL_ROOT = $root
  $env:ML_ASCII_ROOT = $asciiRoot
} else {
  Remove-Item Env:\ML_REAL_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:\ML_ASCII_ROOT -ErrorAction SilentlyContinue
}
$buildDir = $env:CARGO_TARGET_DIR
# lld/dlltool/gcc 需要可写 TEMP，且必须是 ASCII 路径（中文 TMP 会被链接器编码损坏；
# 本机系统 Temp 可能拒绝访问）；放进构建目录（物理在项目内 .tools\target\.tmp）
$tmpDir = Join-Path $buildDir '.tmp'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$env:TMP = $tmpDir; $env:TEMP = $tmpDir
$env:PATH = "$(Join-Path $root '.tools\cargo\bin');$(Join-Path $tc 'bin');$(Join-Path $root '.tools\bin');$(Join-Path $root '.tools\binutils\mingw64\bin');$env:PATH"
$env:RUSTFLAGS = "-C linker=$lld -C linker-flavor=ld.lld -C link-self-contained=yes"

if ($Build) {
  # -Release：strip+lto 优化构建（Cargo.toml [profile.release]），exe 从 ~220MB(debug) 降到 ~10-20MB
  Write-Host "[run] cargo build$(if ($Release) { ' --release' })…"
  Push-Location (Join-Path $root 'native')
  if ($Release) { & $cargo build --release } else { & $cargo build }
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "cargo build 失败（exit $code），请检查上方报错" }
}
if ($BuildOnly) { Write-Host "[run] 构建完成（-BuildOnly 不启动）：$(Join-Path $buildDir "$(if ($Release) { 'release' } else { 'debug' })\interview-orange.exe")"; return }

# 3) 运行
$exe = Join-Path $buildDir "$(if ($Release) { 'release' } else { 'debug' })\interview-orange.exe"
if (-not (Test-Path $exe)) { throw "未找到 $exe，请先加 -Build 构建" }
$loader = Get-ChildItem (Join-Path $buildDir "$(if ($Release) { 'release' } else { 'debug' })\build") -Recurse -Filter WebView2Loader.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like '*\x64\*' } | Select-Object -First 1
if ($loader) { Copy-Item $loader.FullName (Split-Path $exe) -Force }

if ($SelfTest -gt 0) { $env:ML_SELFTEST = "$SelfTest" } else { Remove-Item Env:\ML_SELFTEST -ErrorAction SilentlyContinue }

Write-Host "[run] 启动原生壳：$exe"
& $exe
