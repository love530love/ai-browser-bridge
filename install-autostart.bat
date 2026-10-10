@echo off
REM Double-click entry point. Registers the bridge service to start at logon.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" %*
echo.
pause
