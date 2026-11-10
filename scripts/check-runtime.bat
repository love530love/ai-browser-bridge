@echo off
chcp 65001 >nul
setlocal
set "BRIDGE_SCRIPT=%~1"
if "%BRIDGE_SCRIPT%"=="" set "BRIDGE_SCRIPT=check-runtime.bat"
set "BRIDGE_LOCAL=%~dp0..\.local"
set "BRIDGE_LOG=%BRIDGE_LOCAL%\launcher-error.log"
if not exist "%BRIDGE_LOCAL%" mkdir "%BRIDGE_LOCAL%" >nul 2>nul

where.exe pwsh.exe >nul 2>nul
if errorlevel 1 goto :no_pwsh
where.exe node.exe >nul 2>nul
if errorlevel 1 goto :no_node
REM Node 22 or newer gives exit code 0. Older versions give exit code 1.
node.exe -e "process.exit(Math.max(0, Math.sign(22 - parseInt(process.versions.node, 10))))" >nul 2>nul
if errorlevel 1 goto :old_node
endlocal & exit /b 0

:no_pwsh
echo.
echo [AI Browser Bridge] 缺少 PowerShell 7（pwsh.exe），无法运行 %BRIDGE_SCRIPT%。
echo 安装方式一：winget install --id Microsoft.PowerShell --source winget
echo 安装方式二：下载官方便携版 ZIP，解压后把目录加入用户 PATH。
echo 说明文档：https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows
echo.
>>"%BRIDGE_LOG%" echo %DATE% %TIME% %BRIDGE_SCRIPT% : pwsh.exe not found
pause
endlocal & exit /b 1

:no_node
echo.
echo [AI Browser Bridge] 缺少 Node.js（node.exe），无法运行 %BRIDGE_SCRIPT%。
echo 请安装 Node.js 22 LTS 及以上版本：https://nodejs.org/
echo 安装完成后重新打开终端，再双击本脚本。
echo.
>>"%BRIDGE_LOG%" echo %DATE% %TIME% %BRIDGE_SCRIPT% : node.exe not found
pause
endlocal & exit /b 1

:old_node
echo.
echo [AI Browser Bridge] Node.js 版本过低，需要 22 及以上，无法运行 %BRIDGE_SCRIPT%。
echo 请升级到 Node.js 22 LTS：https://nodejs.org/
echo.
>>"%BRIDGE_LOG%" echo %DATE% %TIME% %BRIDGE_SCRIPT% : node.exe major version below 22
pause
endlocal & exit /b 1
