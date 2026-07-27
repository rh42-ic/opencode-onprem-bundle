#Requires -Version 5.1
<#
.SYNOPSIS
  opencode onprem bundle 环境配置 (Windows PowerShell)
.DESCRIPTION
  工具通过 Scoop-style shim 发现 — bin/ 目录内每个 .exe 都是一个 shim，
  自动转发到 assets/ 中对应的真实可执行文件。
.NOTES
  用法: . .\env.ps1
#>

$env:OPENCODE_ONPREM_DIR = $PSScriptRoot
$env:PATH = "$PSScriptRoot\bin;$env:PATH"

$env:OPENCODE_DISABLE_AUTOUPDATE = "true"
$env:OPENCODE_DISABLE_MODELS_FETCH = "true"
$env:OPENCODE_DISABLE_LSP_DOWNLOAD = "true"

Write-Host "[opencode onprem] loaded from $env:OPENCODE_ONPREM_DIR"
