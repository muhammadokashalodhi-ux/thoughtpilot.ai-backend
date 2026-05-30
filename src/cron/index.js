'use strict';

const cron = require('node-cron');
const { startScheduler, startOnboardingReminderJob } = require('./scheduler');
const { startWeeklyJob } = require('./weekly');

// ── Keepalive ping (prevents Railway from sleeping) ───────────────────────────
function startKeepalive() {
  cron.schedule('*/14 * * * *', () => {
    require('axios')
      .get(process.env.BACKEND_URL || 'https://api.thoughtpilotai.com/health')
      .then(() => console.log(`[keepalive] ✅ ${new Date().toISOString()} — status ok`))
      .catch(() => {});
  });
  console.log('[keepalive] 🟢 Keep-alive cron registered (every 14 min)');
}

// ── Main entry point — called by src/index.js after server starts ─────────────
function startAllCronJobs() {
  startKeepalive();
  startScheduler();
  startWeeklyJob();
  startOnboardingReminderJob();
  console.log('[cron] ✅ All cron jobs registered');
}

module.exports = { startAllCronJobs };
