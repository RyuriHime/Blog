@echo off
rem ============================================================
rem  Forum launcher for Windows
rem  Keep this file ASCII-only and CRLF-terminated: cmd.exe parses
rem  batch files with the OEM codepage, so UTF-8 Chinese text here
rem  would be mis-decoded into bogus commands. The Chinese banner
rem  comes from the Node server instead (readable thanks to chcp).
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- 1. Node from PATH ----
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"

rem ---- 2. DSH bundled runtime (the one this workspace uses) ----
if not defined NODE_BIN if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_BIN=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

rem ---- 3. Common install locations ----
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_BIN goto no_node

if not defined PORT set "PORT=3000"
if not defined HOST set "HOST=127.0.0.1"

echo.
echo   Node    : %NODE_BIN%
echo   Address : http://127.0.0.1:%PORT%
echo   Stop    : press Ctrl+C
echo.

"%NODE_BIN%" "%~dp0src\server.js"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo   Server stopped (exit code %EXIT_CODE%).
echo.
pause
exit /b %EXIT_CODE%

:no_node
echo.
echo   [ERROR] Node.js 22.5 or newer was not found.
echo           Install it from https://nodejs.org and run this file again.
echo.
pause
exit /b 1
