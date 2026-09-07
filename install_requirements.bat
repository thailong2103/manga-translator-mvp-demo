@echo off
title Manga Translator - Setup Environment
cd /d "%~dp0"

echo =========================================================================
echo    CAI DAT MOI TRUONG CHO MANGA TRANSLATOR AI
echo =========================================================================
echo.

:: 1. Kiem tra Python
where python >nul 2>nul
if errorlevel 1 goto NO_PYTHON

echo [1/4] Da tim thay Python tren he thong.
echo       Dang kiem tra moi truong ao .venv...
if not exist ".venv\Scripts\python.exe" (
    echo       Dang tao moi truong ao .venv...
    python -m venv .venv
    if errorlevel 1 goto VENV_ERROR
    echo       [OK] Tao .venv thanh cong.
) else (
    echo       [OK] Da co san moi truong ao .venv.
)

echo.
echo [2/4] Dang nang cap pip...
.\.venv\Scripts\python.exe -m pip install --upgrade pip -q

echo.
echo [3/4] Dang cai dat cac thu vien tu requirements.txt...
echo       (Bao gom ONNX DirectML, Manga-OCR Torchless, OpenCV, Transformers...)
.\.venv\Scripts\pip.exe install -r requirements.txt
if errorlevel 1 goto PIP_ERROR
echo       [OK] Cai dat thu vien thanh cong!

echo.
echo [4/4] Dang kiem tra va tai cac mo hinh AI...
.\.venv\Scripts\python.exe download_models.py
if errorlevel 1 (
    echo [CANH BAO] Co canh bao khi tai mo hinh. Ban co the chay lai download_models.py sau.
)

echo.
echo =========================================================================
echo    CAI DAT HOAN TAT 100%!
echo    Ban co the nhap dup vao file 'start_server.bat' de khoi chay.
echo =========================================================================
echo.
pause
exit /b 0

:NO_PYTHON
echo.
echo [LOI] KHONG TIM THAY PYTHON TREN MAY CUA BAN!
echo Vui long tai va cai dat Python tu: https://www.python.org/downloads/
echo LUU Y QUAN TRONG: Hay tich chon 'Add python.exe to PATH' khi cai dat!
echo.
pause
exit /b 1

:VENV_ERROR
echo.
echo [LOI] Khong the tao moi truong ao .venv!
echo Vui long kiem tra quyen ghi file hoac thu cai dat lai Python.
echo.
pause
exit /b 1

:PIP_ERROR
echo.
echo [LOI] Khong the cai dat thu vien tu requirements.txt!
echo Vui long kiem tra ket noi Internet va thu lai.
echo.
pause
exit /b 1
