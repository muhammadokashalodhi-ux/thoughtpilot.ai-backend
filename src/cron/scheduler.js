// src/cron/scheduler.js
// Runs every hour at :00
// For each user: checks if today's calendar slot matches the current UTC hour
// Sends WA + email notification: "Your post for today is ready to generate/review"
// Uses profiles.post_schedule JSONB for per-day posting times
// Falls back to 9:00 AM UTC if no schedule is set

const cron   = require('node-cron');
const { query } = require('../db/index');
const { sendNotification } = require('../utils/notify');

// ─── Build notification content ────────────────────────────────────────────

function buildMessage({ fullName, dayName, topic }) {
  return (
    `📅 *ThoughtPilot — Post Reminder*\n\n` +
    `Hi ${fullName || 'there'}! Today is *${dayName}* — time to create your LinkedIn post.\n\n` +
    `*Today's Topic:* ${topic || 'Check your calendar'}\n\n` +
    `Review your calendar and generate your post now:\n` +
    `👉 https://thoughtpilotai.com/dashboard/calendar`
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

// ─── Get today's day name in UTC ────────────────────────────────────────────

function getTodayDayName() {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[new Date().getUTCDay()];
}

// ─── Core scheduler logic ───────────────────────────────────────────────────

async function runScheduler() {
  const now         = new Date();
  const currentHour = now.getUTCHours();
  const currentMin  = now.getUTCMinutes();
  const todayName   = getTodayDayName();

  // Safety guard — only run in first 5 min of the hour
  if (currentMin > 5) return;

  console.log(`[scheduler] ⏰ Running at UTC ${currentHour}:${String(currentMin).padStart(2,'0')} — ${todayName}`);

  try {
    // Fetch all active users with notifications on who have a calendar entry for today
    // FIX 1: use u.email as the recipient — not profile.email_from
    // FIX 2: no scheduled_for or source='calendar' dependency — just match today's day_name
    // FIX 3: removed p.auto_schedule and p.post_time (don't exist in schema)
    //        use post_schedule JSONB instead — falls back to hour 9 if not set
    const { rows: dueUsers } = await query(
      `SELECT
         u.id          AS user_id,
         u.email,
         COALESCE(p.full_name, u.full_name) AS full_name,
         p.wa_phone,
         p.wa_apikey,
         p.wa_notifications,
         p.email_notifications,
         p.post_schedule,
         cal.topic,
         cal.theme,
         cal.post_type,
         cal.day_name
       FROM users u
       JOIN profiles p  ON p.user_id = u.id
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

    if (dueUsers.length === 0) {
      console.log(`[scheduler] No calendar entries for ${todayName} — nothing to notify`);
      return;
    }

    console.log(`[scheduler] Found ${dueUsers.length} user(s) with posts planned for ${todayName}`);

    for (const user of dueUsers) {
      try {
        // Determine this user's preferred posting hour from post_schedule JSONB
        // post_schedule shape: { "Monday": 9, "Wednesday": 12, "Friday": 17 } (UTC hours)
        // Default to 9 if not set
        let preferredHour = 9;
        if (user.post_schedule && typeof user.post_schedule === 'object') {
          const h = user.post_schedule[todayName];
          if (typeof h === 'number') preferredHour = h;
        }

        // Only notify at the user's preferred hour
        if (currentHour !== preferredHour) continue;

        // Check we haven't already notified this user today for this type
        const { rows: recentLog } = await query(
          `SELECT id FROM notification_log
           WHERE user_id = $1
             AND type = 'scheduled_post'
             AND sent_at >= CURRENT_DATE
           LIMIT 1`,
          [user.user_id]
        );
        if (recentLog.length > 0) {
          console.log(`[scheduler] Already notified user ${user.user_id} today — skipping`);
          continue;
        }

        const topic = user.topic || user.theme || 'Your planned post';

        const message = buildMessage({
          fullName: user.full_name,
          dayName:  todayName,
          topic,
        });

        const html = buildEmailHtml({
          fullName: user.full_name,
          dayName:  todayName,
          topic,
        });

        // FIX: pass user.email as profile.email so notify.js sends to the right address
        await sendNotification({
          userId:  user.user_id,
          type:    'scheduled_post',
          subject: `📅 Time to post on LinkedIn — ${topic}`,
          message,
          html,
          profile: {
            wa_notifications:    user.wa_notifications,
            wa_phone:            user.wa_phone,
            wa_apikey:           user.wa_apikey,
            email_notifications: user.email_notifications,
            email:               user.email,   // ← users.email — the real recipient
          },
        });

        console.log(`[scheduler] ✅ Notified user ${user.user_id} for ${todayName} — topic: ${topic}`);
      } catch (userErr) {
        console.error(`[scheduler] ❌ Failed for user ${user.user_id}:`, userErr.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] ❌ Fatal error:', err.message);
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
