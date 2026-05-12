// src/cron/index.js
// Called once from src/index.js on server startup
// Registers all cron jobs

const { startKeepalive } = require('./keepalive');
const { startScheduler } = require('./scheduler');

function startAllCronJobs() {
  console.log('[cron] Starting all cron jobs...');
  startKeepalive();
  startScheduler();
  console.log('[cron] ✅ All cron jobs registered');
}

module.exports = { startAllCronJobs };
