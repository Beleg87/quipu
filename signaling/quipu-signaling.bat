@echo off
:: ============================================================================
:: Quipu Signaling Server
:: ============================================================================
::
:: SETUP
::   1. Place this .bat file in the same folder as quipu-signaling-windows-amd64.exe
::   2. Double-click to start, or add to Windows Task Scheduler to run on boot
::
:: FLAGS (append after the exe name below)
::   -addr :8181              Port to listen on (default :8080)
::   -data-file quipu-data.json  Where bans and mod list are stored
::   -admin <fingerprint>     Lock a specific fingerprint as permanent admin
::   -tls-cert cert.pem       TLS certificate (optional, for wss://)
::   -tls-key  key.pem        TLS private key  (optional, for wss://)
::
:: SELF-UPDATE
::   On each start the server checks GitHub for a newer release and updates
::   itself automatically. Set QUIPU_NO_UPDATE=1 to disable this behaviour.
::
:: CRASH RECOVERY
::   This script restarts the server automatically if it exits unexpectedly.
::   Close this window to stop the server permanently.
::
:: ============================================================================

title Quipu Signaling
cd /d "%~dp0"

:loop
echo [%date% %time%] Starting Quipu Signaling Server...
quipu-signaling-windows-amd64.exe -addr :8181
echo [%date% %time%] Server exited (code %errorlevel%). Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto loop
