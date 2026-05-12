// src/cron/index.js
const { startKeepalive } = require('./keepalive');
const { startScheduler } = require('./scheduler');
const { startWeeklyJob } = require('./weekly');

function startAllCronJobs() {
  console.log('[cron] Starting all cron jobs...');
  startKeepalive();     // every 10 min — Railway keep-alive
  startScheduler();     // every hour :00 — calendar post notifications
  startWeeklyJob();     // every Sunday 20:00 UTC — digest + auto calendar reset
  console.log('[cron] ✅ All cron jobs registered');
}

module.exports = { startAllCronJobs };
