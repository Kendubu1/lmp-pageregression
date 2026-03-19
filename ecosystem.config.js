module.exports = {
  apps: [{
    name: 'lmp-pageregression',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    // Pull required env vars from the system environment at start time.
    // PM2 snapshots these when you run `pm2 start` + `pm2 save`, so they
    // persist across reboots via `pm2 resurrect`.
    // If you change env vars later, run: pm2 restart lmp-pageregression --update-env
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      AZURE_STORAGE_CONNECTION_STRING: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      AZURE_STORAGE_CONTAINER_NAME: process.env.AZURE_STORAGE_CONTAINER_NAME || 'images',
      SQL_USER: process.env.SQL_USER || '',
      SQL_PASSWORD: process.env.SQL_PASSWORD || '',
      SQL_DATABASE: process.env.SQL_DATABASE || '',
      SQL_SERVER: process.env.SQL_SERVER || '',
    },
    // Log configuration
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    merge_logs: true
  }]
};
