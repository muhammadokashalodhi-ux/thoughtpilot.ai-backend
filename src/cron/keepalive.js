// src/cron/keepalive.js
// Pings our own /api/health every 10 minutes to prevent Railway from sleeping
// Railway free/hobby tier sleeps after ~15 min of inactivity

const cron = require('node-cron');
const https = require('https');
const http = require('http');

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.thoughtpilotai.com';

function ping() {
  const url = `${BACKEND_URL}/api/health`;
  const lib = url.startsWith('https') ? https : http;

  const req = lib.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.status === 'ok') {
          console.log(`[keepalive] ✅ ${new Date().toISOString()} — status ok, uptime ${data.uptime_seconds}s`);
        } else {
          console.warn(`[keepalive] ⚠️ unexpected status:`, data.status);
        }
      } catch {
        console.warn(`[keepalive] ⚠️ non-JSON response`);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[keepalive] ❌ ping failed:`, err.message);
  });

  req.setTimeout(10000, () => {
    console.warn(`[keepalive] ⚠️ ping timed out`);
    req.destroy();
  });
}

function startKeepalive() {
  // Every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    ping();
  });

  // Ping immediately on startup so we confirm it works
  setTimeout(ping, 5000);

  console.log('[keepalive] 🟢 Keep-alive cron registered (every 10 min)');
}

module.exports = { startKeepalive };
