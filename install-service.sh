#!/bin/bash
# Install and configure lmp-pageregression as a startup service using pm2

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
echo "Useful commands:"
echo "  pm2 status          - Check service status"
echo "  pm2 logs            - View real-time logs"
echo "  pm2 restart all     - Restart the service"
echo "  pm2 stop all        - Stop the service"
