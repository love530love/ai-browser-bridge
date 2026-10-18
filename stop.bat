@echo off
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
