module.exports = {
  apps: [{
    name: 'lmp-pageregression',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // These MUST be set before running the service.
      // Option 1: Set them here directly (not recommended for secrets).
      // Option 2: Set them as system environment variables.
      // Option 3: Use a .env file with pm2's env_production or dotenv.
      //
      // AZURE_STORAGE_CONNECTION_STRING: '',
      // AZURE_STORAGE_CONTAINER_NAME: 'images',
      // SQL_USER: '',
      // SQL_PASSWORD: '',
      // SQL_DATABASE: '',
      // SQL_SERVER: '',
    },
    // Log configuration
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    merge_logs: true
  }]
};
