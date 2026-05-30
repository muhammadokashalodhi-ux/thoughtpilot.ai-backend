'use strict';

const cron = require('node-cron');
const axios = require('axios');

const {
  startScheduler,
  startOnboardingReminderJob
} = require('./scheduler');

const { startWeeklyJob } = require('./weekly');

function startAllCronJobs() {

  // ── Keepalive ping ─────────────────────────────────────
  cron.schedule('*/14 * * * *', async () => {
    try {
      await axios.get(
        process.env.BACKEND_URL ||
        'https://api.thoughtpilotai.com/health'
      );

      console.log(
        `[keepalive] ✅ ${new Date().toISOString()} — status ok`
      );
    } catch (err) {
      console.error('[keepalive] Failed:', err.message);
    }
  });

  console.log(
    '[keepalive] 🟢 Keep-alive cron registered (every 14 min)'
  );

  // ── Other jobs ────────────────────────────────────────
  startScheduler();
  startWeeklyJob();
  startOnboardingReminderJob();

  console.log('[cron] ✅ All cron jobs registered');
}

module.exports = {
  startAllCronJobs
};