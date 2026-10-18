@echo off
pwsh.exe -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0agent.ps1' doctor"
