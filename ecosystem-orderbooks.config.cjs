// ecosystem-orderbooks.config.cjs
// PM2 configuration for running the orderbook collector in production

module.exports = {
  apps: [
    {
      name: 'polymarket-orderbook', 
      script: 'src/workers/orderbook-collector.js', 
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1800M',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
        DEBUG: 'true',
      },
      restart_delay: 8000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/orderbook-error.log', // Log names are correct for this script
      out_file: 'logs/orderbook-out.log',
      merge_logs: true,
      kill_timeout: 15000,

    },
  ],
};