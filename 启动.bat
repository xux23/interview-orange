@echo off
rem 面试橙 · 便携启动（Rust 原生壳）——整目录可复制搬迁，双击即用
rem 热键：Ctrl+Alt+Esc panic · Ctrl+Alt+H 浮窗显隐 · Ctrl+Alt+Shift+X 关浮窗 · Ctrl+Alt+Shift+Q 退出
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动.ps1" %*
