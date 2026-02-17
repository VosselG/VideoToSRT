@echo off
setlocal enableextensions enabledelayedexpansion
chcp 65001 >nul

:: VideoToSRT - Launcher
:: Usage: launcher.bat [dev|prod]
:: - prod: default; standard run
:: - dev: enables developer tools in Electron and debug logging

set "RUN_MODE=%~1"
if "%RUN_MODE%"=="" set "RUN_MODE=prod"

:: =======================
:: Logging bootstrap
:: =======================
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd_HHmmss')"') do set "TS=%%i"
set "LOG_DIR=logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\video_srt_%TS%.log"

echo [INFO] Logging to: "%LOG_FILE%"
IF NOT EXIST "%LOG_FILE%" type nul > "%LOG_FILE%"

:: Live tail window (Only in Dev mode)
if "%RUN_MODE%"=="dev" (
    start "Live log (read-only)" powershell -NoProfile -NoLogo -Command "Get-Content -LiteralPath $env:LOG_FILE -Wait -Tail 50"
)

:: Run the real script inside a subroutine and capture ALL output.
call :RunMain >> "%LOG_FILE%" 2>&1
set "EXITCODE=%ERRORLEVEL%"

echo.>> "%LOG_FILE%"
echo [INFO] Batch exit code: %EXITCODE% >> "%LOG_FILE%"
echo [INFO] Log saved to: %LOG_FILE%

:: Pause if error or explicit failure
if %EXITCODE% NEQ 0 pause
exit /b %EXITCODE%

:RunMain
set "VENV_DIR=venv"
set "REQUIREMENTS_FILE=requirements.txt"

:: 1. Resolve Python
set "PY_CMD="
where py >nul 2>nul
IF %ERRORLEVEL% EQU 0 (
    py -3.11 -V >nul 2>nul && (set "PY_CMD=py -3.11")
)
IF NOT DEFINED PY_CMD (
    where python >nul 2>nul && (set "PY_CMD=python")
)
IF NOT DEFINED PY_CMD (
    echo [FATAL] Python 3.11 not found on PATH. Please install Python 3.11.
    exit /b 1
)
echo [SUCCESS] Using Python via: %PY_CMD%

:: 2. Resolve Node.js (Required for Electron)
where npm >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo [FATAL] Node.js/NPM not found on PATH. Please install Node.js LTS.
    exit /b 1
)
echo [SUCCESS] Node.js detected.

:: 3. Create venv if missing
IF EXIST "%VENV_DIR%\Scripts\activate.bat" GOTO Activate
echo [SETUP] Creating virtual environment in '%VENV_DIR%'...
call %PY_CMD% -m venv "%VENV_DIR%"
IF %ERRORLEVEL% NEQ 0 (
    echo [FATAL] Failed to create virtual environment.
    exit /b 1
)

:Activate
echo [SETUP] Activating environment...
call "%VENV_DIR%\Scripts\activate"

echo [INFO] Python in venv:
python -V

echo [SETUP] Upgrading pip...
python -m pip install -U pip setuptools wheel

echo [SETUP] Installing Python requirements...
pip install --upgrade --upgrade-strategy eager -r "%REQUIREMENTS_FILE%"

:: 4. Check NPM Dependencies (Electron)
IF NOT EXIST "node_modules" (
    echo [SETUP] Installing Node modules - Electron...
    call npm install
)

:: Make Python print immediately
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"

:: Launch the app
echo [INFO] Launching VideoToSRT in mode: %RUN_MODE%
call npm start -- --mode=%RUN_MODE%

IF %ERRORLEVEL% NEQ 0 (
    echo [ERROR] App exited with non-zero code: %ERRORLEVEL%
)
exit /b