<#
.SYNOPSIS
    Corum（矩道）桌面端 Windows 一键打包脚本。

.DESCRIPTION
    在 Windows 构建机上运行：检查工具链 -> 安装依赖 -> 打包 NSIS 安装包 + 免安装 portable。
    产物位于 packages/desktop/dist/。

.PREREQUISITES
    - Node.js >= 22.19（或 >= 24）
    - pnpm >= 11.7（安装：npm i -g pnpm）
    - Visual Studio 生成工具（Desktop development with C++）+ Python 3.x
      node-pty / koffi 等原生模块需按 Electron ABI 重建；electron-builder 在打包时自动重建，
      但重建过程本身需要本机有 C++ 工具链与 Python。
#>

$ErrorActionPreference = 'Stop'

function Test-CommandExists {
  param([string]$cmd)
  return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

Write-Host '==> 检查工具链' -ForegroundColor Cyan
if (-not (Test-CommandExists node)) { Write-Error '未找到 node，请先安装 Node.js >= 22.19' }
if (-not (Test-CommandExists pnpm)) { Write-Error '未找到 pnpm，请先运行：npm i -g pnpm' }

Write-Host "    node  $(node -v)"
Write-Host "    pnpm $(pnpm -v)"

# 原生模块重建依赖：Visual Studio 生成工具 + Python。不强制失败（已装好的机器能过），仅显式告警。
$hasPython = (Test-CommandExists python) -or (Test-CommandExists py) -or (Test-CommandExists python3)
if (-not $hasPython) {
  Write-Warning '未检测到 Python，node-pty/koffi 重建可能失败；请安装 Python 3.x 并加入 PATH。'
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  Write-Warning '未检测到 Visual Studio Installer（vswhere）；原生模块重建可能缺少 C++ 工具链。'
}

# 本脚本位于 scripts/，仓库根在上一级。
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
Write-Host "==> 工作目录：$root" -ForegroundColor Cyan

Write-Host '==> 安装依赖（pnpm install）' -ForegroundColor Cyan
pnpm install

Write-Host '==> 打包 Windows 应用（NSIS + portable）' -ForegroundColor Cyan
pnpm --filter corum-desktop run pack:win

$dist = Join-Path $root 'packages/desktop/dist'
Write-Host '==> 打包完成，产物位于：' -ForegroundColor Green
Write-Host "    $dist"
if (Test-Path $dist) {
  Get-ChildItem $dist | ForEach-Object { Write-Host "    $($_.Name)" }
}
