@echo off
cd backend
echo Instalando dependencias...
pip install -r requirements.txt
echo Iniciando servidor FastAPI na porta 8000...
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
