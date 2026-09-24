@echo off
rem Dental Machine imaging bridge - removes the logon task and the bridge program.
rem Images in C:\DentalMachine\Export are left in place.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
