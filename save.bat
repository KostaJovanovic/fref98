@echo off
rem The quick message is read before delayed expansion is on, or its "!"s go.
setlocal disabledelayedexpansion
set "QMSG=%~2"
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Git helper for File Refragmenter 98 Gold, the same shape as tunebox's and mbrd's save.bat.
rem
rem   save.bat                     menu
rem   save.bat save                commit + push
rem   save.bat commit              commit only
rem   save.bat check               run the Rust and web tests, change nothing
rem   save.bat pull                git pull
rem   save.bat push                git push
rem   save.bat quick "msg"         commit + push, no menu or prompts
rem   save.bat quick-commit "msg"  commit only, no menu or prompts
rem
rem The quick actions are for scripts: the message defaults to "update <date>",
rem every question takes the safe answer (no git init, no pause), and the exit
rem code is non-zero on any failure, a failed push included.
rem
rem Nothing is built here: web\dist and the WASM package are git-ignored, and
rem Cloudflare Pages is not set up yet, so a save is git only.

set "COMMIT_ONLY=0"
set "QUICK=0"
set "SAVE_ERROR=0"
set "ACTION=%~1"
call :resolvebranch

if /i "%ACTION%"=="save"         goto checkrepo
if /i "%ACTION%"=="commit"       (set "COMMIT_ONLY=1" & goto checkrepo)
if /i "%ACTION%"=="check"        goto check
if /i "%ACTION%"=="pull"         goto pull
if /i "%ACTION%"=="push"         goto push
if /i "%ACTION%"=="quick"        (set "QUICK=1" & goto checkrepo)
if /i "%ACTION%"=="quick-commit" (set "QUICK=1" & set "COMMIT_ONLY=1" & goto checkrepo)

:menu
echo.
echo === File Refragmenter 98 Gold ===
echo.
echo   1  commit      add + commit, no push
echo   2  save        add + commit + push
echo   3  check       run the Rust and web tests (changes nothing)
echo   4  pull        git pull
echo   5  push        git push
echo   6  quit
echo.
set "CHOICE="
set /p CHOICE=select [1-6]:
if "%CHOICE%"=="1" (set "COMMIT_ONLY=1" & goto checkrepo)
if "%CHOICE%"=="2" goto checkrepo
if "%CHOICE%"=="3" goto check
if "%CHOICE%"=="4" goto pull
if "%CHOICE%"=="5" goto push
if "%CHOICE%"=="6" exit /b 0
echo [err]  invalid choice
goto menu


:checkrepo
where git >nul 2>nul
if errorlevel 1 (
  echo [err]  git is not installed or not in PATH
  set "SAVE_ERROR=1"
  goto end
)
if exist ".git" goto save
echo.
echo [warn] no git repository here yet
set "DOINIT="
if not "%QUICK%"=="1" set /p DOINIT=run "git init" now? (y/n):
if /i not "%DOINIT%"=="y" (
  echo [git]  skipped - nothing to commit into
  set "SAVE_ERROR=1"
  goto end
)
git init -b main
if errorlevel 1 (
  echo [err]  git init failed
  set "SAVE_ERROR=1"
  goto end
)
call :resolvebranch
goto save


:save
echo.
echo === git: save ===
echo.

rem An unfinished merge must never reach "git add ." - it would stage the
rem conflict markers and record the conflict as settled.
set "UNMERGED="
for /f "delims=" %%u in ('git diff --name-only --diff-filter=U 2^>nul') do set "UNMERGED=1"
if defined UNMERGED (
  echo [err]  unresolved merge conflicts - resolve these first:
  git diff --name-only --diff-filter=U
  set "SAVE_ERROR=1"
  goto end
)

echo [git]  stage
git add .

rem The private test material (test-local\, card images) is git-ignored, but an
rem ignore rule can be edited or bypassed with "git add -f". It must never reach
rem a commit, and this repo is meant to be public, so check what is staged.
rem Photos, card images and scripts only belong in web\public\bundled (none are
rem tracked anywhere else), so any other one staged is private material too.
set "PRIVATE="
for /f "delims=" %%p in ('git diff --cached --name-only --diff-filter=ACMR -- test-local ":(icase)*.img" ":(icase)*.jpg" ":(icase)*.jpeg" ":(icase)*.ps1" ":(icase)*.heic" ":(icase)*.dng" ":(icase)*.cr2" ":(exclude)web/public/bundled" 2^>nul') do (
  if not defined PRIVATE echo [err]  private test material is staged - not saving:
  echo        %%p
  set "PRIVATE=1"
)
if defined PRIVATE (
  echo        unstage it with: git restore --staged ^<path^>
  set "SAVE_ERROR=1"
  goto end
)

rem Private names can hide in text too (a doc quoting a file name). The patterns
rem can't be listed here, since this file is public: they live in the git-ignored
rem test-local\private-patterns.txt, one extended regex per line. Without that
rem file (a fresh clone) the scan is skipped with a warning.
set "PATTERNS=test-local\private-patterns.txt"
if not exist "%PATTERNS%" echo [warn] %PATTERNS% not found - staged text not scanned for private names
set "LEAK="
if exist "%PATTERNS%" for /f "delims=" %%l in ('git grep --cached -nIE -f "%PATTERNS%" 2^>nul') do (
  if not defined LEAK echo [err]  private names in staged files - not saving:
  echo        %%l
  set "LEAK=1"
)
if defined LEAK (
  echo        remove them, or unstage the file with: git restore --staged ^<path^>
  set "SAVE_ERROR=1"
  goto end
)

git diff --cached --quiet
if not errorlevel 1 (
  echo [git]  nothing new to commit
  goto aftercommit
)

rem The version, like mbrd: commit N is 0.NN, stamped into web\src\version.ts
rem before the commit. Only now - a save with nothing to commit must not raise
rem the count. The count is read from the committed file and refused if it
rem can't be read; the history counts too, but only upwards (a plain
rem "git commit" stamps nothing, so the file alone can fall behind).
set "VERFILE=web\src\version.ts"
set "COMMIT_COUNT="
for /f %%i in ('powershell -NoProfile -Command "$m=[regex]::Match((Get-Content '%VERFILE%' -Raw -Encoding UTF8),'export const COMMIT_COUNT = (\d+);'); if($m.Success){$m.Groups[1].Value}"') do set "COMMIT_COUNT=%%i"
if not defined COMMIT_COUNT (
  echo [err]  could not read COMMIT_COUNT from %VERFILE% - not saving
  echo        expected a line of the form:  export const COMMIT_COUNT = 12;
  set "SAVE_ERROR=1"
  goto end
)
set /a NEXT_COUNT=%COMMIT_COUNT%+1
set "GIT_COUNT=0"
for /f %%i in ('git rev-list --count HEAD 2^>nul') do set "GIT_COUNT=%%i"
set /a GIT_NEXT=%GIT_COUNT%+1
if %GIT_NEXT% GTR %NEXT_COUNT% set "NEXT_COUNT=%GIT_NEXT%"
for /f %%v in ('powershell -NoProfile -Command "'0.{0:D2}' -f %NEXT_COUNT%"') do set "VERLABEL=%%v"
echo [ver]  v%VERLABEL% (commit %NEXT_COUNT%)
rem Keep a copy so every failure below puts the file back (:unstamp); a stamp
rem left behind would be read as committed and skip a number next time.
set "STAMP_COPY=%TEMP%\refragmenter-save-version.ts"
copy /y "%VERFILE%" "%STAMP_COPY%" >nul || (echo [err]  could not back up %VERFILE% & set "SAVE_ERROR=1" & goto end)
powershell -NoProfile -Command "$p='%VERFILE%'; $t=[IO.File]::ReadAllText($p); $t=$t -replace 'export const COMMIT_COUNT = \d*;','export const COMMIT_COUNT = %NEXT_COUNT%;' -replace 'export const VERSION = ''[^'']*'';','export const VERSION = ''%VERLABEL%'';'; [IO.File]::WriteAllText($p,$t)"
if errorlevel 1 (
  call :unstamp
  set "SAVE_ERROR=1"
  goto end
)
git add "%VERFILE%"
git status --short

echo.
rem The message never goes through a command line: with delayed expansion on,
rem `git commit -m "%MSG%"` would lose every "!" in it. PowerShell writes it to
rem a UTF-8 file from the environment and git reads the file.
for /f "delims=" %%d in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "NOW=%%d"
set "DEFMSG=v%VERLABEL% - update %NOW%"
set "MSG="
if "%QUICK%"=="1" (
  set "MSG=!QMSG!"
) else (
  set /p "MSG=commit message [%DEFMSG%]: "
)
if not defined MSG set "MSG=%DEFMSG%"
set "MSGFILE=%TEMP%\refragmenter-save-message.txt"
powershell -NoProfile -Command "[IO.File]::WriteAllText($env:MSGFILE, $env:MSG)"
git commit -F "%MSGFILE%"
if errorlevel 1 (
  del "%MSGFILE%" >nul 2>nul
  echo [err]  git commit failed
  call :unstamp
  set "SAVE_ERROR=1"
  goto end
)
del "%MSGFILE%" "%STAMP_COPY%" >nul 2>nul
call :resolvebranch

:aftercommit
if "%COMMIT_ONLY%"=="1" (
  echo.
  echo [git]  committed locally, not pushed
  goto end
)
goto dopush


:push
echo.
echo === git: push ===
:dopush
rem No remote is the normal state until the GitHub repository is made.
if "%REMOTE%"=="" (
  echo.
  echo [git]  no GitHub remote yet - nothing pushed. Add one with:
  echo        git remote add origin https://github.com/KostaJovanovic/fref98.git
  if "%ACTION%"=="push" set "SAVE_ERROR=1"
  goto end
)
if "%BRANCH%"=="" (
  echo [err]  no branch checked out ^(detached HEAD?^) - not pushing
  set "SAVE_ERROR=1"
  goto end
)
rem Only main is public. Other local branches (old history among them) must
rem never be pushed by a save, whatever is checked out.
if /i not "%BRANCH%"=="main" (
  echo [err]  only main is pushed - "%BRANCH%" stays local. Switch with: git switch main
  set "SAVE_ERROR=1"
  goto end
)
echo.
git push -u %REMOTE% main:main
if not errorlevel 1 (
  echo [git]  pushed %REMOTE%/%BRANCH%
  goto end
)
rem A push can fail for reasons a pull cannot fix (auth, no network). Ask the
rem remote which one this is before suggesting anything.
git ls-remote %REMOTE% >nul 2>nul
if errorlevel 1 (
  echo [err]  push failed - cannot reach or authenticate to %REMOTE%. The commit is saved locally.
) else (
  echo [warn] push rejected - %REMOTE%/%BRANCH% has commits you don't. Pull ^(option 4^), then save again.
)
set "SAVE_ERROR=1"
goto end


:check
echo.
echo === check ===
echo.
echo [rust] cargo test
cargo test --workspace
if errorlevel 1 set "SAVE_ERROR=1"
echo.
echo [web]  npm test
pushd web
call npm test
if errorlevel 1 set "SAVE_ERROR=1"
popd
echo.
if "%SAVE_ERROR%"=="0" (echo [ok]   all tests pass) else (echo [err]  some tests failed - see above)
goto end


:pull
echo.
echo === git: pull ===
echo.
if "%BRANCH%"=="" (echo [err]  no branch checked out & set "SAVE_ERROR=1" & goto end)
if "%REMOTE%"=="" (echo [err]  no remote configured yet & set "SAVE_ERROR=1" & goto end)
git pull %REMOTE% %BRANCH%
if errorlevel 1 set "SAVE_ERROR=1"
goto end


rem The checked-out branch into %BRANCH% (empty with no repo or a detached HEAD),
rem and the remote to use into %REMOTE%: the branch's upstream, else origin, else
rem the first remote. Empty when there is none.
:resolvebranch
set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if /i "%BRANCH%"=="HEAD" set "BRANCH="
set "REMOTE="
if not "%BRANCH%"=="" for /f "delims=" %%r in ('git config branch.%BRANCH%.remote 2^>nul') do set "REMOTE=%%r"
if not "%REMOTE%"=="" exit /b 0
git remote get-url origin >nul 2>nul
if not errorlevel 1 (set "REMOTE=origin" & exit /b 0)
for /f "delims=" %%r in ('git remote 2^>nul') do if "!REMOTE!"=="" set "REMOTE=%%r"
exit /b 0


rem Puts web\src\version.ts back from the copy made before the stamp, so the
rem next save reads the same count and uses the same version number again.
:unstamp
copy /y "%STAMP_COPY%" "%VERFILE%" >nul
if errorlevel 1 (
  echo [warn] could not put %VERFILE% back - restore it from %STAMP_COPY%
  exit /b 0
)
git add "%VERFILE%" >nul 2>nul
del "%STAMP_COPY%" >nul 2>nul
echo        the version stamp is put back - the next save is v%VERLABEL% again.
exit /b 0


:end
echo.
if not "%QUICK%"=="1" pause
exit /b %SAVE_ERROR%
