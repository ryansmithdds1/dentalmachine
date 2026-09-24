@echo off
rem Dental Machine imaging bridge - Windows installer.
rem Double-click this file. It asks for administrator permission, installs Node.js if it's missing,
rem copies the bridge to C:\DentalMachine and starts it now and every time you sign in to Windows.
rem The signed-in user is passed along so the bridge runs as them (it has to open imaging programs on their screen).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -RunAsUser "%USERDOMAIN%\%USERNAME%" %*
echo.
pause
