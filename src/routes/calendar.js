const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');

// ─── GET /api/calendar?week=YYYY-MM-DD ───────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const weekStart = req.query.week ? new Date(req.query.week) : getMondayOfWeek(new Date());
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [calResult, pillarsResult] = await Promise.all([
      query(
        `SELECT * FROM calendar WHERE user_id = $1 AND week_start_date = $2 ORDER BY
          CASE day_name WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
            WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7 END`,
        [userId, weekStartStr]
      ),
      query(
        `SELECT id, pillar_name, pillar_icon FROM pillars WHERE user_id = $1 AND is_active = true ORDER BY display_order`,
        [userId]
      ),
    ]);

    res.json({ week_start: weekStartStr, days: calResult.rows, pillars: pillarsResult.rows, is_generated: calResult.rows.length > 0 });
  } catch (err) {
    console.error('[GET /calendar]', err.message);
    res.status(500).json({ error: 'Failed to load calendar' });
  }
});

// ─── POST /api/calendar/generate ─────────────────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { week, days_to_post = ['Monday', 'Wednesday', 'Friday'] } = req.body;

    const weekStart = week ? new Date(week) : getMondayOfWeek(new Date());
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [profileResult, pillarsResult] = await Promise.all([
      query(`SELECT full_name, user_role, sectors, voice_tone, post_length FROM profiles WHERE user_id = $1`, [userId]),
      query(`SELECT id, pillar_name, pillar_icon, description FROM pillars WHERE user_id = $1 AND is_active = true ORDER BY display_order`, [userId]),
    ]);

    const profile = profileResult.rows[0] || {};
    const pillars = pillarsResult.rows;

    if (!pillars.length) return res.status(400).json({ error: 'You need at least one active content pillar to generate a calendar.' });

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
Posting days: ${days_to_post.join(', ')}
Pillars:\n${pillarList}
Create a varied strategic weekly plan. Rotate pillars. Mix post types.`,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    let plan;
    try {
      plan = JSON.parse(groqRes.data.choices[0].message.content.trim().replace(/```json|```/g, '')).plan;
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    await query(`DELETE FROM calendar WHERE user_id = $1 AND week_start_date = $2`, [userId, weekStartStr]);

    const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const planMap = {};
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

    res.json({ week_start: weekStartStr, days: results.map((r) => r.rows[0]), pillars, is_generated: true });
  } catch (err) {
    console.error('[POST /calendar/generate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate calendar' });
  }
});

// ─── PATCH /api/calendar/:id ──────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { theme, topic, category, post_type, custom_override } = req.body;

    const existing = await query(`SELECT id FROM calendar WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Calendar entry not found' });

    const result = await query(
      `UPDATE calendar SET theme = COALESCE($1, theme), topic = COALESCE($2, topic),
       category = COALESCE($3, category), post_type = COALESCE($4, post_type),
       custom_override = COALESCE($5, custom_override)
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [theme, topic, category, post_type, custom_override, req.params.id, userId]
    );

    res.json({ day: result.rows[0] });
  } catch (err) {
    console.error('[PATCH /calendar/:id]', err.message);
    res.status(500).json({ error: 'Failed to update calendar entry' });
  }
});

// ─── PATCH /api/calendar/:id/clear ───────────────────────────────────────────
router.patch('/:id/clear', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE calendar SET theme = NULL, topic = NULL, category = NULL, post_type = NULL, custom_override = NULL
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    res.json({ day: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear day' });
  }
});

// ─── POST /api/calendar/:id/generate-post ────────────────────────────────────
// Generates a post from a calendar slot
// personal_experience: true  → writes in first person using profile data
// personal_experience: false → general thought leadership, no personal claims
router.post('/:id/generate-post', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { personal_experience = true } = req.body;

    const { rows: calRows } = await query(`SELECT * FROM calendar WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    if (!calRows.length) return res.status(404).json({ error: 'Calendar slot not found' });
    const slot = calRows[0];

    const { rows: profileRows } = await query(
      `SELECT p.*, u.email FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`,
      [userId]
    );
    const profile = profileRows[0] || {};

    // Compute scheduled_for
    const dayOffsets = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
    const postDate = new Date(slot.week_start_date);
    postDate.setDate(postDate.getDate() + (dayOffsets[(slot.day_name || '').toLowerCase().trim()] ?? 0));
    const [hours, minutes] = (profile.post_time || '09:00').split(':').map(Number);
    postDate.setUTCHours(hours, minutes || 0, 0, 0);

    // Build profile context for personal experience mode
    const sectors = Array.isArray(profile.sectors) ? profile.sectors.join(', ') : '';
    const profileContext = personal_experience ? [
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

    const systemPrompt = personal_experience
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
Write as general thought leadership using "we", "professionals in this field", "industry data shows" etc.
Voice: ${profile.voice_tone || 'professional'}, boldness ${profile.voice_boldness || 5}/10, length: ${profile.post_length || 'medium'}.
Return only the post body, no hashtags, no preamble.`;

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        temperature: personal_experience ? 0.78 : 0.65,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Write a LinkedIn post about: "${slot.topic || slot.theme}"
Category: ${slot.category || ''}, Type: ${slot.post_type || ''}`,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const body = groqRes.data.choices?.[0]?.message?.content || '';

    const { rows: postRows } = await query(
      `INSERT INTO posts (id, user_id, topic, body, status, source, scheduled_for, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, 'scheduled', 'calendar', $4, NOW(), NOW()) RETURNING *`,
      [userId, slot.topic || slot.theme, body, postDate.toISOString()]
    );

    res.json({ post: postRows[0], calendar: slot });
  } catch (err) {
    console.error('[calendar] generate-post error:', err.message);
    res.status(500).json({ error: 'Failed to generate post' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = router;
