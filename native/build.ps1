# 原生壳构建环境（隔离：只用项目内 .tools，不写系统 PATH / 注册表）
# 用法：. .\build.ps1 ;  cargo build --manifest-path native\Cargo.toml
$root = Split-Path -Parent $PSScriptRoot
$tc = Join-Path $root ".tools\rustup\toolchains\stable-x86_64-pc-windows-gnu"
$lld = Join-Path $tc "lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe"

$env:RUSTUP_HOME = Join-Path $root ".tools\rustup"
$env:CARGO_HOME = Join-Path $root ".tools\cargo"
$env:CARGO_TARGET_DIR = Join-Path $root ".tools\target"
$env:PATH = "$(Join-Path $root '.tools\cargo\bin');$(Join-Path $tc 'bin');$env:PATH"
$env:RUSTFLAGS = "-C linker=$lld -C linker-flavor=ld.lld -C link-self-contained=yes"

Write-Host "[env] rustc: $(& (Join-Path $root '.tools\cargo\bin\rustc.exe') --version)"
Write-Host "[env] CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR"
