// ecosystem-markets.config.cjs
// PM2 configuration for running the market sync worker in production

module.exports = {
apps: [ 
  {
      name: 'polymarket-market-sync',
      script: 'src/workers/market-sync.js', 
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
        DEBUG: 'true',
      },
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/market-sync-error.log', // Log names are now correct for this script
      out_file: 'logs/market-sync-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,

    },
  ], 
};