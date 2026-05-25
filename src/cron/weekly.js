// src/cron/weekly.js
// Runs every Sunday at 8:00 PM UTC
// For each active user:
//   1. Check this week's post activity
//   2. Auto-generate next week's calendar (always — every user gets a fresh plan)
//   3. Send WA + email digest with next week preview + activity warnings

const cron = require('node-cron');
const axios = require('axios');
const { query } = require('../db/index');
const { sendNotification } = require('../utils/notify');

// ─── Calendar generator ────────────────────────────────────────────────────

async function generateCalendarForUser(userId, weekStartStr, profile, pillars) {
  const pillarList = pillars.map((p, i) => `${i + 1}. ${p.pillar_icon} ${p.pillar_name}: ${p.description}`).join('\n');
  const sectors = Array.isArray(profile.sectors) ? profile.sectors.join(', ') : 'general';

  const groqRes = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      max_tokens: 1000,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You are a LinkedIn content strategist. Plan a week of LinkedIn content.
Output ONLY valid JSON — no markdown, no preamble.
JSON shape: { "plan": [ { "day_name": string, "theme": string, "topic": string, "category": string, "post_type": string } ] }
post_type: linkedin_post | insight | story | tip | opinion | case_study
category: thought_leadership | education | engagement | personal`,
        },
        {
          role: 'user',
          content: `Author: ${profile.full_name || 'Professional'}, ${profile.user_role || 'Professional'}
Sectors: ${sectors}
Posting days: Monday, Wednesday, Friday
Pillars:\n${pillarList}
Create a varied strategic weekly plan. Rotate pillars. Mix post types.`,
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  let plan;
  try {
    plan = JSON.parse(groqRes.data.choices[0].message.content.trim().replace(/```json|```/g, '')).plan;
  } catch {
    throw new Error('Failed to parse Groq calendar response');
  }

  await query(`DELETE FROM calendar WHERE user_id = $1 AND week_start_date = $2`, [userId, weekStartStr]);

  const ALL_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const planMap  = {};
  plan.forEach((p) => { planMap[p.day_name] = p; });

  const results = await Promise.all(
    ALL_DAYS.map((day) => {
      const p = planMap[day];
      return query(
        `INSERT INTO calendar (id, user_id, week_start_date, day_name, theme, topic, category, post_type)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, weekStartStr, day, p?.theme || null, p?.topic || null, p?.category || null, p?.post_type || null]
      );
    })
  );

  return results.map((r) => r.rows[0]).filter((d) => d.topic);
}

// ─── Date helpers ──────────────────────────────────────────────────────────

function getNextMondayStr() {
  const d   = new Date();
  const day = d.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

function getThisMondayStr() {
  const d   = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

// ─── Notification content builders ────────────────────────────────────────

function buildDigestMessage({ fullName, nextWeekDays, publishedCount, zeroActivity, lowActivity }) {
  let msg = `📋 *ThoughtPilot — Weekly Digest*\n\nHi ${fullName || 'there'}!\n\n`;

  if (zeroActivity) {
    msg += `💡 *You haven't generated any posts in 3+ days.* Jump back in and keep your LinkedIn presence active!\n\n`;
  } else if (lowActivity) {
    msg += `⚠️ *This week you published ${publishedCount} post${publishedCount === 1 ? '' : 's'} — aim for at least 3 to stay visible.*\n\n`;
  } else {
    msg += `✅ *Great week! You published ${publishedCount} post${publishedCount === 1 ? '' : 's'} this week.*\n\n`;
  }

  if (nextWeekDays.length) {
    msg += `📅 *Next Week's Plan (auto-generated):*\n`;
    nextWeekDays.forEach((d) => {
      msg += `• *${d.day_name}:* ${d.topic || d.theme || 'Rest day'}\n`;
    });
    msg += `\n`;
  }

  msg += `Manage your calendar → https://app.thoughtpilotai.com/dashboard/calendar`;
  return msg;
}

function buildDigestHtml({ fullName, nextWeekDays, publishedCount, zeroActivity, lowActivity }) {
  const warningBanner = zeroActivity
    ? `<div style="background:#1e1a2e;border-left:4px solid #8b5cf6;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#c4b5fd;margin:0;font-size:14px;">💡 <strong>You haven't generated any posts in 3+ days.</strong> Keep your LinkedIn presence active!</p>
       </div>`
    : lowActivity
    ? `<div style="background:#1e1a10;border-left:4px solid #f59e0b;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#fcd34d;margin:0;font-size:14px;">⚠️ <strong>Only ${publishedCount} post${publishedCount === 1 ? '' : 's'} this week.</strong> Aim for at least 3 to stay visible on LinkedIn.</p>
       </div>`
    : `<div style="background:#0d1f0d;border-left:4px solid #22c55e;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#86efac;margin:0;font-size:14px;">✅ <strong>Great week!</strong> You published ${publishedCount} post${publishedCount === 1 ? '' : 's'} this week. Keep it up!</p>
       </div>`;

  const calendarRows = nextWeekDays.length
    ? nextWeekDays.map((d) => `
        <tr>
          <td style="padding:10px 12px;color:#94a3b8;font-size:13px;white-space:nowrap;border-bottom:1px solid #1e2130;">${d.day_name}</td>
          <td style="padding:10px 12px;color:#e2e8f0;font-size:13px;border-bottom:1px solid #1e2130;">${d.topic || d.theme || '<em style="color:#475569">Rest day</em>'}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #1e2130;">
            ${d.topic ? `<span style="background:#1e3a5f;color:#60a5fa;font-size:11px;padding:2px 8px;border-radius:4px;">${d.post_type || 'post'}</span>` : ''}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;color:#475569;text-align:center;font-size:13px;">No calendar for next week yet.</td></tr>`;

  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f1117;color:#e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:32px 24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">📋 Weekly Digest</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">ThoughtPilot AI — Your LinkedIn Co-Pilot</p>
      </div>
      <div style="padding:32px 24px;">
        <p style="color:#cbd5e1;font-size:16px;margin:0 0 20px;">Hi <strong>${fullName || 'there'}</strong> 👋</p>
        ${warningBanner}
        <h2 style="color:#e2e8f0;font-size:16px;font-weight:600;margin:0 0 12px;">📅 Next Week's Plan</h2>
        <table style="width:100%;border-collapse:collapse;background:#1e2130;border-radius:8px;overflow:hidden;margin-bottom:24px;">
          <thead>
            <tr style="background:#161b2e;">
              <th style="padding:10px 12px;color:#64748b;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Day</th>
              <th style="padding:10px 12px;color:#64748b;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Topic</th>
              <th style="padding:10px 12px;color:#64748b;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Type</th>
            </tr>
          </thead>
          <tbody>${calendarRows}</tbody>
        </table>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
          <a href="https://app.thoughtpilotai.com/dashboard/calendar"
             style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px;">
            View Calendar →
          </a>
          <a href="https://app.thoughtpilotai.com/dashboard/generate"
             style="display:inline-block;background:#1e2130;border:1px solid #2d3348;color:#94a3b8;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px;">
            Generate Posts →
          </a>
        </div>
        <p style="color:#475569;font-size:12px;margin:0;">
          Manage notification preferences →
          <a href="https://app.thoughtpilotai.com/dashboard/settings" style="color:#3b82f6;">Settings</a>
        </p>
      </div>
    </div>`;
}

// ─── Main weekly job ───────────────────────────────────────────────────────

async function runWeeklyJob() {
  console.log(`[weekly] 🗓️  Running Sunday weekly job at ${new Date().toISOString()}`);

  const nextWeekStr = getNextMondayStr();
  const thisWeekStr = getThisMondayStr();

  try {
    // FIX: removed p.auto_schedule and p.post_time (not in schema)
    // FIX: added u.email as recipient for email notifications
    const { rows: users } = await query(
      `SELECT
         u.id          AS user_id,
         u.email,
         COALESCE(p.full_name, u.full_name) AS full_name,
         p.wa_phone,    p.wa_apikey,
         p.wa_notifications, p.email_notifications,
         p.sectors,     p.user_role,
         p.voice_tone,  p.post_length,
         p.voice_boldness, p.style_notes
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE u.is_active = true
         AND (p.wa_notifications = true OR p.email_notifications = true)`,
    );

    console.log(`[weekly] Processing ${users.length} user(s)`);

    for (const user of users) {
      try {
        // 1. Count posts generated this week
        const { rows: activityRows } = await query(
          `SELECT COUNT(*) AS cnt, MAX(created_at) AS last_generated
           FROM posts
           WHERE user_id = $1 AND created_at >= $2`,
          [user.user_id, thisWeekStr]
        );
        const publishedCount  = parseInt(activityRows[0]?.cnt || 0);
        const lastGenerated   = activityRows[0]?.last_generated;
        const daysSinceLastPost = lastGenerated
          ? Math.floor((Date.now() - new Date(lastGenerated).getTime()) / (1000 * 60 * 60 * 24))
          : 999;

        const zeroActivity = daysSinceLastPost >= 3;
        const lowActivity  = !zeroActivity && publishedCount < 3;

        // 2. Always auto-generate next week's calendar for every active user
        let nextWeekDays = [];
        try {
          const { rows: pillars } = await query(
            `SELECT pillar_name, pillar_icon, description FROM pillars
             WHERE user_id = $1 AND is_active = true ORDER BY display_order`,
            [user.user_id]
          );

          if (pillars.length) {
            nextWeekDays = await generateCalendarForUser(user.user_id, nextWeekStr, user, pillars);
            console.log(`[weekly] ✅ Auto-generated ${nextWeekDays.length} calendar days for user ${user.user_id}`);
          } else {
            // No pillars — fetch existing calendar if any
            const { rows: existing } = await query(
              `SELECT day_name, topic, theme, post_type FROM calendar
               WHERE user_id = $1 AND week_start_date = $2 AND topic IS NOT NULL
               ORDER BY CASE day_name
                 WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
                 WHEN 'Sunday' THEN 7 END`,
              [user.user_id, nextWeekStr]
            );
            nextWeekDays = existing;
            console.log(`[weekly] ⚠️ No pillars for user ${user.user_id} — using existing calendar`);
          }
        } catch (genErr) {
          console.error(`[weekly] ❌ Calendar gen failed for ${user.user_id}:`, genErr.message);
        }

        // 3. Send digest notification
        const message = buildDigestMessage({ fullName: user.full_name, nextWeekDays, publishedCount, zeroActivity, lowActivity });
        const html    = buildDigestHtml({ fullName: user.full_name, nextWeekDays, publishedCount, zeroActivity, lowActivity });

        // FIX: pass u.email as profile.email so notify.js sends to the correct address
        await sendNotification({
          userId:  user.user_id,
          type:    'weekly_digest',
          subject: `📋 Your LinkedIn week ahead — ThoughtPilot`,
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

        console.log(`[weekly] ✅ Digest sent to user ${user.user_id}`);
      } catch (userErr) {
        console.error(`[weekly] ❌ Failed for user ${user.user_id}:`, userErr.message);
      }
    }

    console.log(`[weekly] ✅ Sunday job complete`);
  } catch (err) {
    console.error('[weekly] ❌ Fatal error in weekly job:', err.message);
  }
}

// ─── Register cron ─────────────────────────────────────────────────────────

function startWeeklyJob() {
  // Every Sunday at 8:00 PM UTC
  cron.schedule('0 20 * * 0', () => {
    runWeeklyJob();
  });
  console.log('[weekly] 🟢 Weekly digest cron registered (Sundays 20:00 UTC)');
}

module.exports = { startWeeklyJob, runWeeklyJob };
