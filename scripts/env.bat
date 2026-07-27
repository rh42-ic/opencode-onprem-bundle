@echo off
REM opencode onprem bundle 环境配置 (Windows CMD)
REM 用法: call env.bat
REM
REM 工具通过 Scoop-style shim 发现 — bin/ 目录内每个 .exe 都是一个 shim，
REM 自动转发到 assets/ 中对应的真实可执行文件。
REM 只需 bin/ 在 PATH 中，无需暴露 assets/ 内部路径。

set "OPENCODE_ONPREM_DIR=%~dp0"
set "PATH=%~dp0bin;%PATH%"

set "OPENCODE_DISABLE_AUTOUPDATE=true"
set "OPENCODE_DISABLE_MODELS_FETCH=true"
set "OPENCODE_DISABLE_LSP_DOWNLOAD=true"

echo [opencode onprem] loaded from %OPENCODE_ONPREM_DIR%
