#!/bin/bash
# Install and configure lmp-pageregression as a startup service using pm2

echo ""
echo "=== Checking required environment variables ==="
MISSING=0
for VAR in AZURE_STORAGE_CONNECTION_STRING SQL_USER SQL_PASSWORD SQL_DATABASE SQL_SERVER; do
    if [ -z "${!VAR}" ]; then
        echo "ERROR: $VAR is not set."
        MISSING=1
    fi
done
if [ "$MISSING" -eq 1 ]; then
    echo ""
    echo "Please set all required environment variables before running this script."
    echo "You can add them to /etc/environment or your shell profile (~/.bashrc, ~/.zshrc)."
    exit 1
fi
echo "All required environment variables are set."

echo "Installing pm2 globally..."
npm install -g pm2

echo "Installing project dependencies..."
npm install

echo "Installing Playwright browsers..."
npx playwright install chromium

echo "Creating logs directory..."
mkdir -p logs

echo "Starting the service with pm2..."
pm2 start ecosystem.config.js

echo "Saving pm2 process list..."
pm2 save

echo "Setting up pm2 to run on system startup..."
pm2 startup

echo ""
echo "Service installed successfully!"
echo "If prompted above, copy and run the sudo command to enable startup."
echo ""
echo "IMPORTANT: If you change environment variables later, run:"
echo "  pm2 restart lmp-pageregression --update-env"
echo ""
echo "Useful commands:"
echo "  pm2 status          - Check service status"
echo "  pm2 logs            - View real-time logs"
echo "  pm2 restart all     - Restart the service"
echo "  pm2 stop all        - Stop the service"
