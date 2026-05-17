@echo off
REM Windows shim for the Makefile targets. Routes to scripts\make.ps1.
REM
REM Usage:
REM   make              show help
REM   make datacaster   build + start + open browser
REM   make up           docker compose up -d
REM   make down         docker compose down
REM   make logs         tail compose logs
REM   make dev-backend  uvicorn (uses .venv)
REM   make dev-frontend vite dev server
REM   make smoke        verify both services answer

setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=help"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make.ps1" %*
exit /b %ERRORLEVEL%
