'use strict';

const { startScheduler, startOnboardingReminderJob } = require('./scheduler');
const { startWeeklyDigest } = require('./weekly');

// ── Keepalive ping (prevents Railway from sleeping) ───────────────────────────
const cron = require('node-cron');
cron.schedule('*/14 * * * *', () => {
  require('axios').get(
    process.env.BACKEND_URL || 'https://api.thoughtpilotai.com/health'
  ).catch(() => {});
});

// ── Register all jobs ─────────────────────────────────────────────────────────
startScheduler();
startWeeklyDigest();
startOnboardingReminderJob();

console.log('[cron] All jobs registered ✓');
