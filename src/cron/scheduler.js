// src/cron/scheduler.js
// Runs every 30 minutes
// For each user: if today has a calendar entry AND current UTC time matches
// their post_time + timezone:
//   1. Auto-generates the LinkedIn post using saved personal_experience preference
//   2. Saves it to posts table as status='scheduled'
//   3. Sends email + WhatsApp: "Your post is ready to review"

const cron      = require('node-cron');
const axios     = require('axios');
const { query } = require('../db/index');
const { sendNotification } = require('../utils/notify');

// ─── Convert local "HH:MM" + timezone → UTC hour+minute ───────────────────

function localTimeToUTC(timeStr, timezone) {
  try {
    const [h, m] = timeStr.split(':').map(Number);
    const utcNow  = new Date();
    const tzParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(utcNow);
    const tzH = parseInt(tzParts.find(p => p.type === 'hour').value);
    const tzM = parseInt(tzParts.find(p => p.type === 'minute').value);
    const utcH = utcNow.getUTCHours();
    const utcM = utcNow.getUTCMinutes();
    let offsetMins = (tzH * 60 + tzM) - (utcH * 60 + utcM);
    if (offsetMins > 720)  offsetMins -= 1440;
    if (offsetMins < -720) offsetMins += 1440;
    let utcTotalMins = ((h * 60 + m) - offsetMins + 1440) % 1440;
    return { utcHour: Math.floor(utcTotalMins / 60), utcMin: utcTotalMins % 60 };
  } catch {
    const [h, m] = timeStr.split(':').map(Number);
    return { utcHour: h, utcMin: m || 0 };
  }
}

// ─── Auto-generate post via Groq ──────────────────────────────────────────

async function generatePost(slot, profile, personalExperience) {
  const sectors = Array.isArray(profile.sectors) ? profile.sectors.join(', ') : '';

  const profileContext = personalExperience ? [
    profile.full_name        && `Name: ${profile.full_name}`,
    profile.user_role        && `Role: ${profile.user_role}`,
    profile.user_headline    && `Headline: ${profile.user_headline}`,
    profile.years_experience && `Years of experience: ${profile.years_experience}`,
    sectors                  && `Sectors: ${sectors}`,
    profile.companies        && `Companies: ${profile.companies}`,
    profile.achievements     && `Achievements: ${profile.achievements}`,
    profile.credentials      && `Credentials: ${profile.credentials}`,
    profile.projects         && `Projects: ${profile.projects}`,
  ].filter(Boolean).join('\n') : '';

  const systemPrompt = personalExperience
    ? `You are a LinkedIn ghostwriter for ${profile.full_name || 'a professional'}.
Write in first person using ONLY details explicitly mentioned in the profile data below.
DO NOT invent or assume any experience, companies, or metrics not in the profile.
Voice: ${profile.voice_tone || 'authentic'}, boldness ${profile.voice_boldness || 5}/10, length: ${profile.post_length || 'medium'}.
${profile.style_notes ? `Style notes: ${profile.style_notes}` : ''}
Return only the post body, no hashtags, no preamble.

PROFILE DATA (use only what is here):
${profileContext}`
    : `You are a LinkedIn content writer. Write a general professional post about the given topic.
DO NOT use first person personal claims, invented experiences, or fake metrics.
Write as general thought leadership — use "we", "professionals in this field", "industry data shows" etc.
Voice: ${profile.voice_tone || 'professional'}, boldness ${profile.voice_boldness || 5}/10, length: ${profile.post_length || 'medium'}.
Return only the post body, no hashtags, no preamble.`;

  const groqRes = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       'llama-3.3-70b-versatile',
      max_tokens:  800,
      temperature: personalExperience ? 0.78 : 0.65,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Write a LinkedIn post about: "${slot.topic || slot.theme}"
Category: ${slot.category || ''}, Type: ${slot.post_type || ''}`,
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  return groqRes.data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Notification builders ────────────────────────────────────────────────

function buildMessage({ fullName, dayName, topic, personalExperience }) {
  const mode = personalExperience ? '(with your personal experience)' : '(general thought leadership)';
  return (
    `✅ *ThoughtPilot — Post Ready!*\n\n` +
    `Hi ${fullName || 'there'}! Your LinkedIn post for *${dayName}* has been auto-generated ${mode}.\n\n` +
    `*Topic:* ${topic}\n\n` +
    `Review and approve it now:\n` +
    `👉 https://app.thoughtpilotai.com/dashboard/queue`
  );
}

function buildEmailHtml({ fullName, dayName, topic, personalExperience, bodyPreview }) {
  const modeLabel = personalExperience
    ? '<span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;">Personal Experience ON</span>'
    : '<span style="background:#dbeafe;color:#2563eb;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;">General Thought Leadership</span>';

  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f1117;color:#e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:32px 24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">✅ Post Ready to Review</h1>
        <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">ThoughtPilot AI — Your LinkedIn Co-Pilot</p>
      </div>
      <div style="padding:32px 24px;">
        <p style="color:#cbd5e1;font-size:16px;margin:0 0 16px;">Hi <strong>${fullName || 'there'}</strong> 👋</p>
        <p style="color:#94a3b8;font-size:15px;margin:0 0 20px;">
          Your <strong style="color:#e2e8f0;">${dayName}</strong> post has been auto-generated and is waiting for your approval.
        </p>
        <div style="background:#1e2130;border:1px solid #2d3348;border-radius:8px;padding:20px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0;">Topic</p>
            ${modeLabel}
          </div>
          <p style="color:#e2e8f0;font-size:15px;font-weight:600;margin:0 0 14px;">${topic}</p>
          <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Preview</p>
          <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0;font-style:italic;">"${bodyPreview}..."</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
          <a href="https://app.thoughtpilotai.com/dashboard/queue"
             style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
            Review &amp; Approve →
          </a>
          <a href="https://app.thoughtpilotai.com/dashboard/calendar"
             style="display:inline-block;background:#1e2130;border:1px solid #2d3348;color:#94a3b8;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
            View Calendar
          </a>
        </div>
        <p style="color:#475569;font-size:12px;margin:0;">
          Manage notification preferences →
          <a href="https://app.thoughtpilotai.com/dashboard/settings" style="color:#3b82f6;">Settings</a>
        </p>
      </div>
    </div>
  `;
}

function getTodayDayName() {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getUTCDay()];
}

// ─── Core scheduler logic ─────────────────────────────────────────────────

async function runScheduler() {
  const now        = new Date();
  const utcHour    = now.getUTCHours();
  const utcMin     = now.getUTCMinutes();
  const todayName  = getTodayDayName();

  console.log(`[scheduler] ⏰ ${todayName} UTC ${String(utcHour).padStart(2,'0')}:${String(utcMin).padStart(2,'0')}`);

  try {
    // Fetch active users with today's calendar entry + notifications on
    const { rows: users } = await query(
      `SELECT
         u.id          AS user_id,
         u.email,
         COALESCE(p.full_name, u.full_name)          AS full_name,
         p.wa_phone,       p.wa_apikey,
         p.wa_notifications, p.email_notifications,
         COALESCE(p.post_time, '09:00')              AS post_time,
         COALESCE(p.timezone,  'UTC')                AS timezone,
         COALESCE(p.notification_email, u.email)     AS notif_email,
         p.full_name      AS profile_name,
         p.user_role,     p.user_headline,
         p.years_experience, p.sectors,
         p.companies,     p.achievements,
         p.credentials,   p.projects,
         p.voice_tone,    p.voice_boldness,
         p.post_length,   p.style_notes,
         cal.id           AS cal_id,
         cal.topic,       cal.theme,
         cal.day_name,    cal.post_type,
         cal.category,
         COALESCE(cal.personal_experience, true)     AS personal_experience
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       JOIN calendar cal
         ON cal.user_id = u.id
        AND cal.day_name = $1
        AND cal.week_start_date = DATE_TRUNC('week', CURRENT_DATE)::date
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
        // Check if time matches within 30-min window
        const { utcHour: targetH, utcMin: targetM } = localTimeToUTC(user.post_time, user.timezone);
        const targetTotal  = targetH * 60 + targetM;
        const currentTotal = utcHour * 60 + utcMin;
        const diff = Math.abs(currentTotal - targetTotal);
        const withinWindow = diff <= 30 || diff >= (1440 - 30);

        if (!withinWindow) {
          console.log(`[scheduler] User ${user.user_id}: target UTC ${targetH}:${String(targetM).padStart(2,'0')} — not yet`);
          continue;
        }

        // Deduplicate — already notified today?
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

        // Also check if post already generated for this calendar slot today
        const { rows: existingPost } = await query(
          `SELECT id FROM posts
           WHERE user_id = $1
             AND source = 'calendar'
             AND DATE(created_at) = CURRENT_DATE
             AND topic = $2
           LIMIT 1`,
          [user.user_id, user.topic]
        );
        if (existingPost.length > 0) {
          console.log(`[scheduler] Post already generated for user ${user.user_id} today`);
          continue;
        }

        const topic = user.topic || user.theme || 'Your planned post';
        console.log(`[scheduler] Auto-generating post for user ${user.user_id} — "${topic}" (personal_experience: ${user.personal_experience})`);

        // ── Auto-generate the post ──
        let postBody = '';
        try {
          postBody = await generatePost(
            { topic: user.topic, theme: user.theme, category: user.category, post_type: user.post_type },
            {
              full_name:        user.profile_name,
              user_role:        user.user_role,
              user_headline:    user.user_headline,
              years_experience: user.years_experience,
              sectors:          user.sectors,
              companies:        user.companies,
              achievements:     user.achievements,
              credentials:      user.credentials,
              projects:         user.projects,
              voice_tone:       user.voice_tone,
              voice_boldness:   user.voice_boldness,
              post_length:      user.post_length,
              style_notes:      user.style_notes,
            },
            user.personal_experience
          );
        } catch (genErr) {
          console.error(`[scheduler] Groq failed for user ${user.user_id}:`, genErr.message);
          continue;
        }

        // ── Save post to DB as 'scheduled' ──
        await query(
          `INSERT INTO posts (id, user_id, topic, body, status, source, created_at, updated_at)
           VALUES (uuid_generate_v4(), $1, $2, $3, 'scheduled', 'calendar', NOW(), NOW())`,
          [user.user_id, topic, postBody]
        );

        console.log(`[scheduler] ✅ Post saved for user ${user.user_id}`);

        // ── Send notification ──
        const bodyPreview = postBody.substring(0, 120).replace(/\n/g, ' ');

        await sendNotification({
          userId:  user.user_id,
          type:    'scheduled_post',
          subject: `✅ Your LinkedIn post for ${todayName} is ready — ${topic}`,
          message: buildMessage({ fullName: user.full_name, dayName: todayName, topic, personalExperience: user.personal_experience }),
          html:    buildEmailHtml({ fullName: user.full_name, dayName: todayName, topic, personalExperience: user.personal_experience, bodyPreview }),
          profile: {
            wa_notifications:    user.wa_notifications,
            wa_phone:            user.wa_phone,
            wa_apikey:           user.wa_apikey,
            email_notifications: user.email_notifications,
            email:               user.notif_email,
          },
        });

        console.log(`[scheduler] ✅ Notification sent to user ${user.user_id}`);
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