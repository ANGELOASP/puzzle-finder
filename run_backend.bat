@echo off
cd /d "%~dp0backend"
echo Instalando dependencias do Python...
py -m pip install -r requirements.txt
echo.
echo ========================================================
echo Iniciando servidor FastAPI PuzzleFinder na porta 8000...
echo Acesse localmente: http://localhost:8000
echo ========================================================
echo.
py -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
