@echo off
REM Double-click entry point. Registers the bridge service to start at logon.
pwsh.exe -NoProfile -File "%~dp0install-autostart.ps1" %*
set "BRIDGE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %BRIDGE_EXIT%
