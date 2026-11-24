# 重建 .tools 工具链（Rust stable-gnu + mingw64 binutils）——独立环境，全部装入项目内 .tools，不写系统 PATH / 注册表
# 用法：
#   powershell -ExecutionPolicy Bypass -File native\toolchain.ps1             # 全量（rustup + mingw）
#   powershell -ExecutionPolicy Bypass -File native\toolchain.ps1 -SkipMingw  # 只装 rust 工具链
# 下载源（均为国内可达镜像，失效时按注释里的备选换源）：
#   rustup-init / 工具链 channel ：rsproxy.cn（RUSTUP_DIST_SERVER=https://rsproxy.cn）
#   mingw64 binutils（gcc/windres/dlltool）：GitHub niXman release，经 ghfast.top 中转（备选 ghproxy.net）
#   解压 7z：Bandizip 控制台 bz.exe（已安装则直接用），否则提示安装
param([switch]$SkipMingw)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dl = Join-Path $root '.tools\dl'
New-Item -ItemType Directory -Force -Path $dl | Out-Null

$MINGW_TAG = '16.2.0-rt_v14-rev1'
$MINGW_ASSET = 'x86_64-16.2.0-release-posix-seh-ucrt-rt_v14-rev1.7z'

function Download($outFile, $urls) {
  foreach ($u in $urls) {
    if (Test-Path $outFile) { return $true }
    Write-Host "[toolchain] 下载 $(Split-Path -Leaf $outFile) ← $u"
    try {
      # 用 .NET WebClient 走系统代理；curl 对 302/断流容错差
      Invoke-WebRequest -Uri $u -OutFile $outFile -UseBasicParsing -TimeoutSec 600
      if ((Get-Item $outFile).Length -gt 1MB) { return $true }
      Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    } catch { Write-Host "[toolchain] 失败：$($_.Exception.Message)" }
  }
  return $false
}

# ── 1) Rust stable-gnu 工具链 ───────────────────────────────────────────
$cargoExe = Join-Path $root '.tools\cargo\bin\cargo.exe'
if (Test-Path $cargoExe) {
  Write-Host "[toolchain] Rust 工具链已存在，跳过（删除 .tools\rustup 与 .tools\cargo 可强制重装）"
} else {
  $init = Join-Path $dl 'rustup-init.exe'
  # 主源 rsproxy；备选官方 static.rust-lang.org
  Download $init @(
    "https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
    "https://static.rust-lang.org/dist/x86_64-pc-windows-msvc/rustup-init.exe"
  ) | Out-Null
  if (-not (Test-Path $init)) { throw "rustup-init.exe 下载失败，请检查网络或手工换源" }
  $env:RUSTUP_HOME = Join-Path $root '.tools\rustup'
  $env:CARGO_HOME = Join-Path $root '.tools\cargo'
  # 注意：rsproxy 的 dist 根在 https://rsproxy.cn（不是 /rustup 子路径）
  $env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn'
  $env:RUSTUP_UPDATE_ROOT = 'https://rsproxy.cn/rustup/release'
  & $init -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain stable
  & $cargoExe --version
}

# ── 2) mingw64 binutils（windres/gcc -E/dlltool，tauri-build 编译图标资源需要） ──
$mingwGcc = Join-Path $root '.tools\binutils\mingw64\bin\gcc.exe'
if ($SkipMingw) {
  Write-Host '[toolchain] -SkipMingw：跳过 mingw64'
} elseif (Test-Path $mingwGcc) {
  Write-Host '[toolchain] mingw64 已存在，跳过（删除 .tools\binutils 可强制重装）'
} else {
  $arch = Join-Path $dl $MINGW_ASSET
  $gh = "https://github.com/niXman/mingw-builds-binaries/releases/download/$MINGW_TAG/$MINGW_ASSET"
  Download $arch @($gh, "https://ghfast.top/$gh", "https://ghproxy.net/$gh") | Out-Null
  if (-not (Test-Path $arch)) { throw "mingw64 下载失败，请检查网络或手工换源" }
  # 解压：优先 Bandizip 控制台 bz.exe，其次系统 7z
  $bz = @('C:\Program Files\Bandizip\bz.exe', 'C:\Program Files (x86)\Bandizip\bz.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  $sevenZ = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
  $dest = Join-Path $root '.tools\binutils'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  if ($bz) { & $bz x -y "-o:$dest" $arch | Out-Null }
  elseif ($sevenZ) { & $sevenZ x -y "-o$dest" $arch | Out-Null }
  else { throw "未找到 7z 解压工具（Bandizip bz.exe / 7-Zip）。请安装后重跑，或手工把 $MINGW_ASSET 解压到 $dest" }
  & $mingwGcc --version | Select-Object -First 1
}

# ── 3) windres/gcc 改写 shim（中文项目路径必需；纯 ASCII 路径下行为透传，装上也无害） ──
# tauri-build 生成的 resource.rc 里烙有 CARGO_MANIFEST_DIR 真实路径，项目路径含中文时
# windres 打不开 ICON（Invalid argument）。shim 把 rc 内容 / gcc 参数中的真实根路径
# 改写成 ASCII junction 路径后转发给 .tools\binutils 里的真工具。
$shimProbe = Join-Path $root '.tools\bin\x86_64-w64-mingw32-windres.exe'
if (Test-Path $shimProbe) {
  Write-Host '[toolchain] windres/gcc shim 已存在，跳过（删除 .tools\bin 可强制重装）'
} else {
  if (-not (Test-Path $mingwGcc)) { throw '缺少 mingw64 gcc，无法编译 shim（重跑时不要加 -SkipMingw）' }
  # gcc/ld 不认中文路径：编译须在 ASCII 工作目录 → 经项目根 junction（ml-src）操作，物理文件仍在项目内
  $workRoot = $root
  if ($root -match '[^\x20-\x7E]') {
    $workRoot = $null
    foreach ($d in (Get-PSDrive -PSProvider FileSystem)) {
      $j = "$($d.Root)ml-src"
      $it = Get-Item $j -Force -ErrorAction SilentlyContinue
      if ($it -and $it.LinkType -eq 'Junction' -and $it.Target -eq $root -and (Test-Path $j)) { $workRoot = $j; break }
      if ($it -and $it.LinkType -ne 'Junction') { continue }
      try {
        if ($it) { Remove-Item $j -Force -ErrorAction Stop }
        New-Item -ItemType Junction -Path $j -Target $root -ErrorAction Stop | Out-Null
        Write-Host "[toolchain] 已创建 ASCII junction：$j → $root"
        $workRoot = $j; break
      } catch { continue }
    }
    if (-not $workRoot) { throw '项目路径含非 ASCII 且无法创建 ASCII junction，请把项目移到纯英文路径' }
  }
  $binDir = Join-Path $root '.tools\bin'
  $tmp2 = Join-Path $workRoot '.tools\target\.tmp'
  New-Item -ItemType Directory -Force -Path $binDir, $tmp2 | Out-Null
  $env:TMP = $tmp2; $env:TEMP = $tmp2
  $srcDir = Join-Path $workRoot 'native\tools'   # 经 junction 的 ASCII 源码路径
  Push-Location $tmp2
  try {
    & $mingwGcc -O2 -o (Join-Path $workRoot '.tools\bin\gcc.exe') (Join-Path $srcDir 'gcc-shim.c') -municode
    & $mingwGcc -O2 -o (Join-Path $workRoot '.tools\bin\x86_64-w64-mingw32-windres.exe') (Join-Path $srcDir 'windres-shim.c') -municode
    & $mingwGcc -O2 -o (Join-Path $workRoot '.tools\bin\windres.exe') (Join-Path $srcDir 'windres-shim.c') -municode
  } finally { Pop-Location }
  Write-Host "[toolchain] shim 已装入 $binDir（gcc / x86_64-w64-mingw32-windres / windres）"
}

Write-Host "[toolchain] 完成。构建：powershell -File native\run.ps1 -Build -BuildOnly"
