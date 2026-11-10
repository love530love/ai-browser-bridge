@echo off
chcp 65001 >nul
setlocal
set "BRIDGE_ROOT=%~dp0"
set "BRIDGE_LOCAL=%BRIDGE_ROOT%.local"
set "BRIDGE_LOG=%BRIDGE_LOCAL%\launcher-error.log"
set "BRIDGE_ARGS=%*"

if not exist "%BRIDGE_LOCAL%" mkdir "%BRIDGE_LOCAL%" >nul 2>nul

where node.exe >nul 2>nul
if errorlevel 1 goto :no_node

node.exe "%~dp0scripts\doctor-host-env.mjs" %*
set "BRIDGE_EXIT=%ERRORLEVEL%"
if "%BRIDGE_EXIT%"=="9009" goto :no_node

if not "%BRIDGE_EXIT%"=="0" (
  echo.
  echo [AI Browser Bridge] 宿主环境诊断发现明确失败项（退出码 %BRIDGE_EXIT%），请按上方「修复」处理。
  >>"%BRIDGE_LOG%" echo %DATE% %TIME% doctor-lite.bat : doctor-host-env.mjs exit %BRIDGE_EXIT%
  if "%BRIDGE_ARGS%"=="" pause
  exit /b %BRIDGE_EXIT%
)

echo.
if "%BRIDGE_ARGS%"=="" (
  echo [AI Browser Bridge] 诊断完成，未发现明确失败项。
  pause
)
exit /b 0

:no_node
echo.
echo [AI Browser Bridge] 未找到 node.exe，无法运行宿主环境诊断。
echo 本入口只依赖 Node.js 22 LTS，不需要任何额外脚本宿主。
echo 安装方式：winget install --id OpenJS.NodeJS.LTS --source winget
echo   或到 https://nodejs.org 下载 Node.js 22 LTS 安装包，装好后重开窗口再双击本文件。
echo 说明：doctor-lite.bat 直接调用 node.exe 运行 scripts\doctor-host-env.mjs。
>>"%BRIDGE_LOG%" echo %DATE% %TIME% doctor-lite.bat : node.exe not found in PATH
pause
exit /b 1
