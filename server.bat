@echo off
setlocal
title File Refragmenter server
cd /d "%~dp0"

rem Runs File Refragmenter 98 Gold on this PC for working on it: rebuilds the Rust engine to WASM,
rem then starts Vite's dev server (hot reload for web\src) and opens the browser.
rem
rem   server.bat              http://localhost:5734, also reachable from phones on the Wi-Fi
rem   server.bat --local      this PC only
rem   server.bat --port 9000  another port
rem
rem 5734 is "JPEG" on a phone keypad, off the well-worn ports (3000, 5173, 8000)
rem so it never fights another project for one. --strictPort makes Vite fail
rem instead of quietly moving to the next port.

set "PORT=5734"
set "HOST=--host"
:args
if "%~1"=="" goto argsdone
if /i "%~1"=="--local" (set "HOST=" & shift & goto args)
if /i "%~1"=="--port"  (set "PORT=%~2" & shift & shift & goto args)
echo [err]  unknown option %1
goto fail
:argsdone

where node >nul 2>nul || (echo [err]  Node.js is not installed or not in PATH & goto fail)

rem Free the port, but only from a previous run of this script: a node process
rem whose command line is this repo's Vite. Anything else holding the port is
rem reported and left alone, and Vite then fails to bind and says so.
powershell -NoProfile -Command ^
  "$mine = '%~dp0web\node_modules\'.Replace('\\','\');" ^
  "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue |" ^
  "  Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 } | ForEach-Object {" ^
  "    $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $_\" -ErrorAction SilentlyContinue;" ^
  "    if ($p -and $p.CommandLine -and $p.CommandLine.Replace('/','\') -like ('*' + $mine + '*vite*')) {" ^
  "      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue" ^
  "    } elseif ($p) {" ^
  "      Write-Host ('Port %PORT% is held by PID ' + $p.ProcessId + ': ' + $p.Name) -ForegroundColor Yellow;" ^
  "      Write-Host ('  ' + $p.CommandLine) -ForegroundColor DarkGray;" ^
  "      Write-Host '  Not this project''s server - leaving it alone.' -ForegroundColor Yellow" ^
  "    }" ^
  "  }"

pushd web

if not exist "node_modules" (
  echo [npm]  first run - installing packages
  call npm install || (popd & goto fail)
)

rem The engine. cargo only rebuilds what changed, so this is quick when the Rust
rem side is untouched. Without cargo, an engine built earlier is still usable.
where cargo >nul 2>nul
if errorlevel 1 (
  if exist "src\wasm\pkg\refragmenter_wasm.js" (
    echo [warn] cargo is not in PATH - using the engine built earlier, Rust changes are not included
  ) else (
    echo [err]  cargo is not in PATH and the engine has never been built.
    echo        Install Rust, then: rustup target add wasm32-unknown-unknown
    echo        and: cargo install wasm-bindgen-cli --version 0.2.100
    popd & goto fail
  )
) else (
  echo [wasm] building the engine
  call npm run wasm || (popd & goto fail)
)

rem Find local IP for phone access
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined LOCAL_IP (
    for /f "tokens=* delims= " %%b in ("%%a") do set "LOCAL_IP=%%b"
  )
)

echo.
echo ============================================
echo   Local:   http://localhost:%PORT%
if defined HOST echo   Network: http://%LOCAL_IP%:%PORT%
if defined HOST echo.
if defined HOST echo   Phone must be on the same Wi-Fi. The webcam
if defined HOST echo   only works on localhost or HTTPS, not here.
echo ============================================
echo.

rem --open waits until Vite is listening before it opens the browser.
call npm run dev -- %HOST% --port %PORT% --strictPort --open
popd
pause
exit /b 0

:fail
echo.
pause
exit /b 1
