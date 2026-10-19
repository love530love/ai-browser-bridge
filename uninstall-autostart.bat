@echo off
REM Double-click entry point. Removes the logon auto-start registration.
pwsh.exe -NoProfile -File "%~dp0uninstall-autostart.ps1" %*
set "BRIDGE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %BRIDGE_EXIT%
