@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0agent.ps1' doctor"