// src/cron/scheduler.js
// Runs every 30 minutes
// For each user: checks if today has a calendar entry AND current UTC time
// matches their post_time + timezone. Sends notification if so.

const cron      = require('node-cron');
const { query } = require('../db/index');
const { sendNotification } = require('../utils/notify');

// ─── Convert "HH:MM" + timezone → UTC hour+minute ─────────────────────────

function localTimeToUTC(timeStr, timezone) {
  try {
    // timeStr = "19:30", timezone = "Asia/Dubai"
    const [h, m] = timeStr.split(':').map(Number);
    // Build a date string for today in that timezone at that time
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    // Use Intl to find the UTC offset for this timezone right now
    const localDate = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    // Get what that local time is in the given timezone by formatting UTC
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    // Find offset: format current UTC time in the timezone, compare
    const utcNow   = new Date();
    const tzParts  = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(utcNow);

    const tzH = parseInt(tzParts.find(p => p.type === 'hour').value);
    const tzM = parseInt(tzParts.find(p => p.type === 'minute').value);
    const utcH = utcNow.getUTCHours();
    const utcM = utcNow.getUTCMinutes();

    // offset in minutes = local - utc
    let offsetMins = (tzH * 60 + tzM) - (utcH * 60 + utcM);
    // Normalize to [-720, 720]
    if (offsetMins > 720)  offsetMins -= 1440;
    if (offsetMins < -720) offsetMins += 1440;

    // Convert desired local time to UTC
    let utcTotalMins = (h * 60 + m) - offsetMins;
    // Normalize
    utcTotalMins = ((utcTotalMins % 1440) + 1440) % 1440;

    return {
      utcHour: Math.floor(utcTotalMins / 60),
      utcMin:  utcTotalMins % 60,
    };
  } catch {
    // Fallback: treat as UTC
    const [h, m] = timeStr.split(':').map(Number);
    return { utcHour: h, utcMin: m };
  }
}

// ─── Notification builders ─────────────────────────────────────────────────

function buildMessage({ fullName, dayName, topic }) {
  return (
    `📅 *ThoughtPilot — Post Reminder*\n\n` +
    `Hi ${fullName || 'there'}! Today is *${dayName}* — time to create your LinkedIn post.\n\n` +
    `*Today's Topic:* ${topic || 'Check your calendar'}\n\n` +
    `Generate your post now:\n` +
    `👉 https://thoughtpilotai.com/dashboard/generate`
  );
}

function buildEmailHtml({ fullName, dayName, topic }) {
  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f1117;color:#e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:32px 24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">📅 Post Reminder</h1>
        <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">ThoughtPilot AI — Your LinkedIn Co-Pilot</p>
      </div>
      <div style="padding:32px 24px;">
        <p style="color:#cbd5e1;font-size:16px;margin:0 0 16px;">Hi <strong>${fullName || 'there'}</strong> 👋</p>
        <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">
          Today is <strong style="color:#e2e8f0;">${dayName}</strong> — your content calendar has a post lined up for you.
        </p>
        <div style="background:#1e2130;border:1px solid #2d3348;border-radius:8px;padding:20px;margin-bottom:24px;">
          <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px;">Today's topic</p>
          <p style="color:#e2e8f0;font-size:16px;font-weight:600;margin:0;">${topic || 'Check your calendar'}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
          <a href="https://thoughtpilotai.com/dashboard/generate"
             style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
            Generate Post →
          </a>
          <a href="https://thoughtpilotai.com/dashboard/calendar"
             style="display:inline-block;background:#1e2130;border:1px solid #2d3348;color:#94a3b8;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
            View Calendar
          </a>
        </div>
        <p style="color:#475569;font-size:12px;margin:0;">
          Manage notification preferences →
          <a href="https://thoughtpilotai.com/dashboard/settings" style="color:#3b82f6;">Settings</a>
        </p>
      </div>
    </div>
  `;
}

function getTodayDayName() {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getUTCDay()];
}

// ─── Core logic ────────────────────────────────────────────────────────────

async function runScheduler() {
  const now        = new Date();
  const utcHour    = now.getUTCHours();
  const utcMin     = now.getUTCMinutes();
  const todayName  = getTodayDayName();

  console.log(`[scheduler] ⏰ ${todayName} UTC ${String(utcHour).padStart(2,'0')}:${String(utcMin).padStart(2,'0')}`);

  try {
    // Fetch all active users with:
    // - notifications enabled
    // - a calendar entry for today with a topic
    // - post_time set (falls back to '09:00')
    // - timezone set (falls back to 'UTC')
    // SELECT u.email as the recipient — not profile.email_from
    const { rows: users } = await query(
      `SELECT
         u.id          AS user_id,
         u.email,
         COALESCE(p.full_name, u.full_name) AS full_name,
         p.wa_phone,
         p.wa_apikey,
         p.wa_notifications,
         p.email_notifications,
         COALESCE(p.post_time, '09:00')   AS post_time,
         COALESCE(p.timezone,  'UTC')     AS timezone,
         COALESCE(p.notification_email, u.email) AS notif_email,
         cal.topic,
         cal.theme,
         cal.day_name
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       JOIN calendar cal
         ON cal.user_id = u.id
        AND cal.day_name = $1
        AND cal.week_start_date = (
              DATE_TRUNC('week', CURRENT_DATE + INTERVAL '1 day') - INTERVAL '1 day'
            )::date
       WHERE u.is_active = true
         AND cal.topic IS NOT NULL
         AND (p.wa_notifications = true OR p.email_notifications = true)`,
      [todayName]
    );

    if (users.length === 0) {
      console.log(`[scheduler] No calendar entries for ${todayName}`);
      return;
    }

    for (const user of users) {
      try {
        // Convert their local post_time to UTC and check if now matches (within 30 min window)
        const { utcHour: targetH, utcMin: targetM } = localTimeToUTC(user.post_time, user.timezone);
        const targetTotalMins  = targetH * 60 + targetM;
        const currentTotalMins = utcHour * 60 + utcMin;

        // Match within a 30-minute window (cron runs every 30 min)
        const diff = Math.abs(currentTotalMins - targetTotalMins);
        const withinWindow = diff <= 30 || diff >= (1440 - 30); // handle midnight wrap

        if (!withinWindow) {
          console.log(`[scheduler] User ${user.user_id}: post_time ${user.post_time} ${user.timezone} → UTC ${targetH}:${String(targetM).padStart(2,'0')} — not now (current UTC ${utcHour}:${String(utcMin).padStart(2,'0')})`);
          continue;
        }

        // Deduplicate — don't notify twice today
        const { rows: alreadySent } = await query(
          `SELECT id FROM notification_log
           WHERE user_id = $1 AND type = 'scheduled_post' AND sent_at >= CURRENT_DATE
           LIMIT 1`,
          [user.user_id]
        );
        if (alreadySent.length > 0) {
          console.log(`[scheduler] Already notified user ${user.user_id} today`);
          continue;
        }

        const topic = user.topic || user.theme || 'Your planned post';

        await sendNotification({
          userId:  user.user_id,
          type:    'scheduled_post',
          subject: `📅 Time to post on LinkedIn — ${topic}`,
          message: buildMessage({ fullName: user.full_name, dayName: todayName, topic }),
          html:    buildEmailHtml({ fullName: user.full_name, dayName: todayName, topic }),
          profile: {
            wa_notifications:    user.wa_notifications,
            wa_phone:            user.wa_phone,
            wa_apikey:           user.wa_apikey,
            email_notifications: user.email_notifications,
            email:               user.notif_email, // notification_email or users.email
          },
        });

        console.log(`[scheduler] ✅ Notified user ${user.user_id} — ${topic}`);
      } catch (e) {
        console.error(`[scheduler] ❌ user ${user.user_id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] ❌ Fatal:', err.message);
  }
}

// ─── Register cron — every 30 minutes ──────────────────────────────────────

function startScheduler() {
  cron.schedule('0,30 * * * *', () => { runScheduler(); });
  console.log('[scheduler] 🟢 Post scheduler cron registered (every 30 min)');
}

module.exports = { startScheduler, runScheduler };