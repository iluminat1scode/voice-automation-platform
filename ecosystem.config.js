// PM2 Configuration for Production Deployment
// Author: iluminat1scode
// Purpose: Process management and clustering configuration

module.exports = {
  apps: [{
    // Application name
    name: 'voice-automation-platform',
    
    // Entry point
    script: './index.js',
    
    // Cluster mode configuration
    instances: process.env.PM2_INSTANCES || 4,
    exec_mode: 'cluster',
    
    // Environment variables for development
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug'
    },
    
    // Environment variables for production
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      LOG_LEVEL: 'info'
    },
    
    // Logging configuration
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Process management
    max_memory_restart: '1G',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Advanced features
    merge_logs: true,
    cron_restart: '0 0 * * *', // Restart daily at midnight
    
    // Node.js arguments
    node_args: '--max-old-space-size=1024',
    
    // Monitoring
    instance_var: 'INSTANCE_ID',
    
    // Source maps support
    source_map_support: true
  }],

  // Deployment configuration
  deploy: {
    production: {
      user: 'node',
      host: process.env.DEPLOY_HOST || 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:iluminat1scode/voice-automation-platform.git',
      path: '/var/www/voice-platform',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      'ssh_options': 'StrictHostKeyChecking=no'
    },
    
    staging: {
      user: 'node',
      host: process.env.STAGING_HOST || 'staging.your-server.com',
      ref: 'origin/develop',
      repo: 'git@github.com:iluminat1scode/voice-automation-platform.git',
      path: '/var/www/voice-platform-staging',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env staging',
      env: {
        NODE_ENV: 'staging'
      }
    }
  },

  // Monitoring configuration
  monitoring: {
    http: true,
    https: false,
    port: 9615,
    host: '0.0.0.0'
  }
};
