@echo off
chcp 65001 >nul
setlocal
call "%~dp0scripts\check-runtime.bat" status.bat
if errorlevel 1 exit /b 1
pwsh.exe -NoProfile -File "%~dp0agent.ps1" -Action status
set "BRIDGE_EXIT=%ERRORLEVEL%"
if "%BRIDGE_EXIT%"=="0" exit /b 0
echo.
echo [AI Browser Bridge] status.bat 运行失败，退出码 %BRIDGE_EXIT%。
echo 详情见项目根目录 .local\launcher-error.log，可运行 doctor.bat 进一步诊断。
if not exist "%~dp0.local" mkdir "%~dp0.local" >nul 2>nul
>>"%~dp0.local\launcher-error.log" echo %DATE% %TIME% status.bat : exit %BRIDGE_EXIT%
pause
exit /b %BRIDGE_EXIT%
