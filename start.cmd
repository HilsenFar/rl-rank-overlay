@echo off
rem RL Rank Overlay launcher.
rem Starts the local reader (Node) and then the transparent window.
setlocal
cd /d "%~dp0"

rem Prefer the bundled Node runtime; fall back to a Node on PATH.
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"

rem Reuse a reader that is already listening (RLOverlay.exe does the same).
>nul 2>&1 (netstat -an | findstr /r /c:":8342 .*LISTENING" ) && goto ready

rem Start the reader in the background (reads the game, asks the watcher).
start "" /min "%NODE%" "%~dp0src\overlay.mjs"

rem Wait until the local page is listening (up to ~15 s).
set /a tries=0
:wait
>nul 2>&1 (netstat -an | findstr /r /c:":8342 .*LISTENING" ) && goto ready
set /a tries+=1
if %tries% geq 30 goto ready
>nul timeout /t 1 /nobreak
goto wait

:ready
start "" "%~dp0RLOverlay.exe"
endlocal
