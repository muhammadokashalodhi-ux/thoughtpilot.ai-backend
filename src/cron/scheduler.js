// src/cron/scheduler.js
// Runs every hour at :00
// Finds all calendar-linked posts scheduled for this hour
// Sends WA + email notification to users who have notifications enabled
// Only fires for posts originating from the Content Calendar (source = 'calendar')

const cron = require('node-cron');
const { query } = require('../db/index');
const { sendNotification } = require('../utils/notify');

// ─── Build notification content ────────────────────────────────────────────

function buildMessage({ fullName, dayName, topic, body }) {
  const preview = body ? body.substring(0, 120).replace(/\n/g, ' ') + '...' : 'No preview available';
  return (
    `📅 *ThoughtPilot — Post Reminder*\n\n` +
    `Hi ${fullName || 'there'}! Your LinkedIn post for *${dayName}* is scheduled for now.\n\n` +
    `*Topic:* ${topic || 'Not set'}\n\n` +
    `*Preview:*\n${preview}\n\n` +
    `Head to ThoughtPilot to review and publish → https://thoughtpilotai.com/dashboard/queue`
  );
}

function buildEmailHtml({ fullName, dayName, topic, body }) {
  const preview = body ? body.substring(0, 300).replace(/\n/g, '<br>') + '...' : 'No preview available';
  return `
    <div style="font-family: 'DM Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f1117; color: #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #3b82f6, #8b5cf6); padding: 32px 24px; text-align: center;">
        <h1 style="color: #fff; margin: 0; font-size: 22px; font-weight: 700;">📅 Post Reminder</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 14px;">ThoughtPilot AI</p>
      </div>
      <div style="padding: 32px 24px;">
        <p style="color: #cbd5e1; font-size: 16px; margin: 0 0 16px;">Hi <strong>${fullName || 'there'}</strong>,</p>
        <p style="color: #94a3b8; font-size: 15px; margin: 0 0 24px;">
          Your LinkedIn post for <strong style="color: #e2e8f0;">${dayName}</strong> is scheduled for right now.
        </p>
        <div style="background: #1e2130; border: 1px solid #2d3348; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px;">Topic</p>
          <p style="color: #e2e8f0; font-size: 15px; font-weight: 600; margin: 0 0 16px;">${topic || 'Not set'}</p>
          <p style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px;">Preview</p>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 0;">${preview}</p>
        </div>
        <a href="https://thoughtpilotai.com/dashboard/queue"
           style="display: inline-block; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; text-decoration: none;
                  padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px;">
          Review &amp; Publish →
        </a>
        <p style="color: #475569; font-size: 13px; margin: 24px 0 0;">
          You're receiving this because you have post notifications enabled.<br>
          <a href="https://thoughtpilotai.com/dashboard/settings" style="color: #3b82f6;">Manage notification settings</a>
        </p>
      </div>
    </div>
  `;
}

// ─── Core scheduler logic ───────────────────────────────────────────────────

async function runScheduler() {
  const now = new Date();
  const currentHour = now.getUTCHours();   // compare in UTC
  const currentMinute = now.getUTCMinutes();

  // Only run near the top of the hour (within first 5 min) to avoid duplicate sends
  // The cron itself fires at :00 but this is a safety guard
  if (currentMinute > 5) return;

  console.log(`[scheduler] ⏰ Running at UTC ${currentHour}:${String(currentMinute).padStart(2, '0')}`);

  try {
    // Find all users who:
    // 1. Have a post_time matching the current UTC hour
    // 2. Have at least one notification channel enabled
    // 3. Have calendar-sourced posts in status 'scheduled' or 'approved'
    // 4. Have a scheduled_for timestamp today matching this hour
    const { rows: duePosts } = await query(
      `SELECT
         po.id            AS post_id,
         po.user_id,
         po.topic,
         po.body,
         po.scheduled_for,
         cal.day_name,
         p.wa_phone,
         p.wa_apikey,
         p.wa_notifications,
         p.email_notifications,
         p.email_from,
         p.timezone,
         COALESCE(p.full_name, u.full_name) AS full_name
       FROM posts po
       JOIN profiles p  ON p.user_id = po.user_id
       JOIN users u     ON u.id = po.user_id
       LEFT JOIN calendar cal ON cal.user_id = po.user_id
                              AND cal.day_name = TO_CHAR(po.scheduled_for AT TIME ZONE COALESCE(p.timezone, 'UTC'), 'Day')
       WHERE po.source = 'calendar'
         AND po.status IN ('scheduled', 'approved')
         AND po.scheduled_for IS NOT NULL
         AND EXTRACT(HOUR FROM po.scheduled_for AT TIME ZONE 'UTC') = $1
         AND DATE(po.scheduled_for AT TIME ZONE 'UTC') = CURRENT_DATE
         AND (p.wa_notifications = true OR p.email_notifications = true)`,
      [currentHour]
    );

    if (duePosts.length === 0) {
      console.log(`[scheduler] No posts due at hour ${currentHour} UTC`);
      return;
    }

    console.log(`[scheduler] Found ${duePosts.length} post(s) due — sending notifications`);

    for (const post of duePosts) {
      const message = buildMessage({
        fullName: post.full_name,
        dayName: (post.day_name || '').trim(),
        topic: post.topic,
        body: post.body,
      });

      const html = buildEmailHtml({
        fullName: post.full_name,
        dayName: (post.day_name || '').trim(),
        topic: post.topic,
        body: post.body,
      });

      await sendNotification({
        userId: post.user_id,
        type: 'scheduled_post',
        subject: `📅 Your LinkedIn post is ready to publish — ${post.topic || 'ThoughtPilot'}`,
        message,
        html,
        profile: {
          wa_notifications: post.wa_notifications,
          wa_phone: post.wa_phone,
          wa_apikey: post.wa_apikey,
          email_notifications: post.email_notifications,
          email_from: post.email_from,
        },
      });

      // Mark post as notified — update status to 'published'
      // (user still needs to actually post on LinkedIn manually, but we flag it)
      await query(
        `UPDATE posts SET status = 'published', updated_at = NOW() WHERE id = $1`,
        [post.post_id]
      );

      console.log(`[scheduler] ✅ Notified user ${post.user_id} for post ${post.post_id}`);
    }
  } catch (err) {
    console.error('[scheduler] ❌ Error during scheduling run:', err.message);
  }
}

// ─── Register cron ─────────────────────────────────────────────────────────

function startScheduler() {
  // Every hour at :00 exactly
  cron.schedule('0 * * * *', () => {
    runScheduler();
  });

  console.log('[scheduler] 🟢 Post scheduler cron registered (every hour at :00)');
}

module.exports = { startScheduler, runScheduler };
