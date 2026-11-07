@echo off
rem IT Support Toolkit - double-click to test the site on this PC.
setlocal
title IT Support Toolkit - local
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

:menu
cls
echo ==================================================
echo    IT Support Toolkit  -  local test
echo ==================================================
echo.
if exist "docs\data.enc.json" (
  echo    Content: built - ready to open
) else (
  echo    Content: NOT built yet - option 1 will build it first
)
echo.
echo    1. Open the site on this PC
echo    2. Rebuild content after editing, then open the site
echo    3. Check content for mistakes
echo    4. Deploy to GitHub  - build, commit, push
echo    5. Exit
echo.
set "choice="
set /p "choice=   Choose 1-5 and press Enter: "
if "%choice%"=="1" goto open
if "%choice%"=="2" goto rebuild
if "%choice%"=="3" goto check
if "%choice%"=="4" goto deploy
if "%choice%"=="5" goto end
goto menu

:rebuild
echo.
call npm run build
if errorlevel 1 goto failed
goto serve

:open
if exist "docs\data.enc.json" goto serve
echo.
echo No content yet - building it first. Choose your website username and password.
echo.
call npm run build
if errorlevel 1 goto failed
goto serve

:serve
echo.
echo Starting the local site - your browser opens automatically.
echo Keep this window open while testing. Press Ctrl+C here to stop.
echo.
node tools\serve.mjs --open
echo.
pause
goto menu

:check
echo.
call npm run check
echo.
pause
goto menu

:deploy
echo.
call npm run deploy
if errorlevel 1 goto failed
echo.
pause
goto menu

:failed
echo.
echo Something went wrong - read the message above.
pause
goto menu

:nonode
echo Node.js is not installed.
echo Install the LTS version from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:end
endlocal
exit /b 0
