module.exports = {
  apps: [{
    name: 'mostar-lsv',
    cwd: __dirname,
    script: 'server.ts',
    interpreter: '/usr/bin/node',
    node_args: '--import tsx',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    env: { NODE_ENV: 'production', PORT: '3001', LSV_AUTOMATIC_ALERTS: '0' },
  }],
};
