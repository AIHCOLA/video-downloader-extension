@echo off
chcp 65001 >nul
setlocal
title HLS Downloader - Local Web UI
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  Double-click this file to start the local web UI (127.0.0.1:8765).
rem  This launcher is intentionally ASCII-only for maximum reliability
rem  with cmd.exe; the Chinese banner is printed by app.py itself.
rem ------------------------------------------------------------------

set "PYTHON_EXE="
where python >nul 2>nul && set "PYTHON_EXE=python"
if not defined PYTHON_EXE (
    where py >nul 2>nul && set "PYTHON_EXE=py -3"
)
if not defined PYTHON_EXE (
    echo.
    echo [ERROR] Python not found.
    echo Please install Python 3.10+ and add it to PATH, then run this file again.
    echo.
    pause
    exit /b 1
)

%PYTHON_EXE% "%~dp0app.py" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] The web UI exited with code %EXIT_CODE%.
    echo.
    pause
)
endlocal
