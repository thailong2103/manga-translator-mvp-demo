@echo off
title Manga Translator Server - Port 8765
cd /d "%~dp0"

echo =========================================================================
echo    DANG KHOI DONG SERVER DICH MANGA AI (PORT 8765)
echo =========================================================================
echo.

:: 1. Kiem tra moi truong ao .venv
if exist ".venv\Scripts\python.exe" goto CHECK_MODELS

echo [THONG BAO] Chua tim thay moi truong ao .venv!
echo Dang tu dong chay cai dat moi truong cho ban...
echo.
call install_requirements.bat
if not exist ".venv\Scripts\python.exe" (
    echo [LOI] Khong tim thay .venv sau khi cai dat.
    pause
    exit /b 1
)

:CHECK_MODELS
:: 2. Kiem tra mo hinh Comic-Text-Detector
if exist "models\comic-text-detector.onnx" goto START_SERVER

echo [THONG BAO] Dang kiem tra va tai mo hinh AI...
.\.venv\Scripts\python.exe download_models.py

:START_SERVER
echo.
echo =========================================================================
echo    SERVER DANG CHAY TAI: http://127.0.0.1:8765
echo    (Dang tu dong mo trinh duyet Web Reader...)
echo    Nhan Ctrl + C de dung server khi khong su dung.
echo =========================================================================
echo.

:: 3. Tu dong mo trinh duyet sau 2 giay
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8765"

:: 4. Chay server chinh bang Python trong .venv
.\.venv\Scripts\python.exe overlay_server.py
if errorlevel 1 (
    echo.
    echo [THONG BAO] Server da dung hoac gap su co.
    pause
)
