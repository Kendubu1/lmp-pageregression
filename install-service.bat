@echo off
REM Install and configure lmp-pageregression as a Windows startup service using pm2
REM Run this script as Administrator

echo Installing pm2 globally...
call npm install -g pm2
call npm install -g pm2-windows-startup

echo Installing project dependencies...
call npm install

echo Installing Playwright browsers...
call npx playwright install chromium

echo Creating logs directory...
if not exist "logs" mkdir logs

echo Starting the service with pm2...
call pm2 start ecosystem.config.js

echo Saving pm2 process list...
call pm2 save

echo Setting up pm2 to run on Windows startup...
call pm2-startup install

echo.
echo Service installed successfully!
echo The service will now start automatically when Windows starts.
echo.
echo Useful commands:
echo   pm2 status          - Check service status
echo   pm2 logs            - View real-time logs
echo   pm2 restart all     - Restart the service
echo   pm2 stop all        - Stop the service
echo.
pause
