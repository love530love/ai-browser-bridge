@echo off
REM Double-click entry point. Removes the logon auto-start registration.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-autostart.ps1" %*
echo.
pause
