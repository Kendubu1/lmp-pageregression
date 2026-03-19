@echo off
REM Install and configure lmp-pageregression as a Windows startup service using pm2
REM Run this script as Administrator

echo.
echo === Checking required environment variables ===
if "%AZURE_STORAGE_CONNECTION_STRING%"=="" (
    echo ERROR: AZURE_STORAGE_CONNECTION_STRING is not set.
    echo Please set all required environment variables as system variables before running this script:
    echo   AZURE_STORAGE_CONNECTION_STRING
    echo   SQL_USER, SQL_PASSWORD, SQL_DATABASE, SQL_SERVER
    echo.
    echo You can set them via: System Properties ^> Environment Variables ^> System Variables
    pause
    exit /b 1
)

echo Installing pm2 globally...
call npm install -g pm2
call npm install -g pm2-windows-service

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

echo Setting up pm2 as a Windows service...
call pm2-service-install

echo.
echo Service installed successfully!
echo The service will now start automatically when Windows starts.
echo.
echo IMPORTANT: Make sure your Azure and SQL environment variables are set
echo as SYSTEM environment variables (not user-level) so the service can
echo access them on boot.
echo.
echo Useful commands:
echo   pm2 status          - Check service status
echo   pm2 logs            - View real-time logs
echo   pm2 restart all     - Restart the service
echo   pm2 stop all        - Stop the service
echo.
pause
