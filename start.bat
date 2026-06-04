@echo off
echo Iniciando Dashboard SDR Copa Energia...
echo.
cd /d "%~dp0"
start "" "http://localhost:4000"
node server.js
