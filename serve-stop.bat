@echo off
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0.venv\Scripts\python.exe" "%~dp0serve.py" --stop
"%~dp0.venv\Scripts\python.exe" "%~dp0serve.py" --status
echo.
pause
