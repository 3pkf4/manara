// تشغيل بـ pm2:  pm2 start ecosystem.config.js && pm2 save
// الإعدادات والأسرار تُقرأ من ملف .env (انسخ .env.example إلى .env أولاً)
const path = require('path');
const root = __dirname;
module.exports = {
  apps: [
    {
      name: 'manara-pos',
      script: './server/server.js',
      cwd: root,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      restart_delay: 3000,
      max_restarts: 10,
      env: { NODE_ENV: 'production' },   // PORT / HOST / TRUST_PROXY ... من .env
      error_file: path.join(root, 'logs/pm2-error.log'),
      out_file: path.join(root, 'logs/pm2-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,
      kill_timeout: 5000
    }
    // النفق (اختياري، للتجارب فقط):  pm2 start scripts/cloudflare-tunnel.sh --name manara-tunnel -- watch
  ]
};
