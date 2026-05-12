const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');

// ─── GET /api/calendar?week=YYYY-MM-DD ───────────────────────────────────────
// Returns the week's calendar for the user (week_start_date = Monday)
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { week } = req.query;

    // Default to current week's Monday
    const weekStart = week ? new Date(week) : getMondayOfWeek(new Date());
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM calendar WHERE user_id = $1 AND week_start_date = $2 ORDER BY
        CASE day_name
          WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
          WHEN 'Sunday' THEN 7 END`,
      [userId, weekStartStr]
    );

    // Also grab pillars for pillar dropdown
    const pillarsResult = await query(
      `SELECT id, pillar_name, pillar_icon FROM pillars WHERE user_id = $1 AND is_active = true ORDER BY display_order`,
      [userId]
    );

    res.json({
      week_start: weekStartStr,
      days: result.rows,
      pillars: pillarsResult.rows,
      is_generated: result.rows.length > 0,
    });
  } catch (err) {
    console.error('[GET /calendar]', err.message);
    res.status(500).json({ error: 'Failed to load calendar' });
  }
});

// ─── POST /api/calendar/generate ─────────────────────────────────────────────
// AI-generates a full week plan based on user's pillars and profile
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { week, days_to_post = ['Monday', 'Wednesday', 'Friday'] } = req.body;

    const weekStart = week ? new Date(week) : getMondayOfWeek(new Date());
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // Load profile + active pillars
    const [profileResult, pillarsResult] = await Promise.all([
      query(
        `SELECT full_name, user_role, sectors, voice_tone, post_length FROM profiles WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT id, pillar_name, pillar_icon, description FROM pillars
         WHERE user_id = $1 AND is_active = true ORDER BY display_order`,
        [userId]
      ),
    ]);

    const profile = profileResult.rows[0] || {};
    const pillars = pillarsResult.rows;

    if (!pillars.length) {
      return res.status(400).json({ error: 'You need at least one active content pillar to generate a calendar.' });
    }

    // Call Groq to plan the week
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
            content: `You are a LinkedIn content strategist for professionals across any industry. Plan a week of LinkedIn content.
Output ONLY valid JSON — no markdown, no preamble.
JSON shape: { "plan": [ { "day_name": string, "pillar_name": string, "theme": string, "topic": string, "category": string, "post_type": string } ] }
post_type must be one of: linkedin_post, insight, story, tip, opinion, case_study
category must be one of: thought_leadership, education, engagement, personal`,
          },
          {
            role: 'user',
            content: `Author: ${profile.full_name || 'Professional'}, ${profile.user_role || 'Professional'}
Sectors: ${sectors}
Posting days this week: ${days_to_post.join(', ')}

Content pillars:
${pillarList}

Create a varied, strategic weekly LinkedIn content plan. Rotate pillars. Mix post types. Make topics specific and timely.`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const raw = groqRes.data.choices[0].message.content.trim();
    let plan;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      plan = JSON.parse(cleaned).plan;
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    // Delete existing week and reinsert
    await query(
      `DELETE FROM calendar WHERE user_id = $1 AND week_start_date = $2`,
      [userId, weekStartStr]
    );

    const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const planMap = {};
    plan.forEach((p) => { planMap[p.day_name] = p; });

    const inserts = ALL_DAYS.map((day) => {
      const p = planMap[day];
      return query(
        `INSERT INTO calendar (id, user_id, week_start_date, day_name, theme, topic, category, post_type)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          userId, weekStartStr, day,
          p?.theme || null,
          p?.topic || null,
          p?.category || null,
          p?.post_type || null,
        ]
      );
    });

    const results = await Promise.all(inserts);
    const days = results.map((r) => r.rows[0]);

    res.json({ week_start: weekStartStr, days, pillars: pillarsResult.rows, is_generated: true });
  } catch (err) {
    console.error('[POST /calendar/generate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate calendar' });
  }
});

// ─── PATCH /api/calendar/:id ──────────────────────────────────────────────────
// Update a single calendar day (manual override)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { theme, topic, category, post_type, custom_override } = req.body;

    const existing = await query(
      `SELECT * FROM calendar WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Calendar entry not found' });

    const result = await query(
      `UPDATE calendar
       SET theme = COALESCE($1, theme),
           topic = COALESCE($2, topic),
           category = COALESCE($3, category),
           post_type = COALESCE($4, post_type),
           custom_override = COALESCE($5, custom_override)
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [theme, topic, category, post_type, custom_override, id, userId]
    );

    res.json({ day: result.rows[0] });
  } catch (err) {
    console.error('[PATCH /calendar/:id]', err.message);
    res.status(500).json({ error: 'Failed to update calendar entry' });
  }
});

// ─── DELETE /api/calendar/:id/clear ──────────────────────────────────────────
// Clear a day's content (set to rest day)
router.patch('/:id/clear', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const result = await query(
      `UPDATE calendar
       SET theme = NULL, topic = NULL, category = NULL, post_type = NULL, custom_override = NULL
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId]
    );

    res.json({ day: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear day' });
  }
});

// ─── POST /api/calendar/:id/generate-post ────────────────────────────────────
// Instantly generate a post from a calendar day and save as draft
router.post('/:id/generate-post', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const dayResult = await query(
      `SELECT c.*, p.id as pillar_uuid, p.pillar_name, p.description as pillar_desc, p.prompt as pillar_prompt
       FROM calendar c
       LEFT JOIN pillars p ON p.pillar_name = c.theme AND p.user_id = c.user_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, userId]
    );

    if (!dayResult.rows.length) return res.status(404).json({ error: 'Calendar entry not found' });
    const day = dayResult.rows[0];

    if (!day.topic) return res.status(400).json({ error: 'This day has no topic. Edit the day first.' });

    // Find the right pillar (by name match or first active)
    let pillarId = day.pillar_uuid;
    if (!pillarId) {
      const fallback = await query(
        `SELECT id FROM pillars WHERE user_id = $1 AND is_active = true ORDER BY display_order LIMIT 1`,
        [userId]
      );
      pillarId = fallback.rows[0]?.id;
    }

    if (!pillarId) return res.status(400).json({ error: 'No active pillars found.' });

    // Reuse posts generate endpoint logic inline
    const [profileResult, pillarResult] = await Promise.all([
      query(
        `SELECT full_name, user_role, years_experience, voice_boldness, voice_tone, post_length, style_notes
         FROM profiles WHERE user_id = $1`,
        [userId]
      ),
      query(`SELECT * FROM pillars WHERE id = $1`, [pillarId]),
    ]);

    const profile = profileResult.rows[0] || {};
    const pillar = pillarResult.rows[0] || {};
    const boldness = profile.voice_boldness || 5;
    const length = { short: '150–250 words', medium: '250–400 words', long: '400–600 words' }[profile.post_length] || '250–400 words';

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        temperature: 0.82,
        messages: [
          {
            role: 'system',
            content: `You are a LinkedIn ghostwriter for ${profile.full_name || 'a senior professional'}, ${profile.user_role || 'Industry Leader'}.
Voice: ${profile.voice_tone || 'professional'}, boldness ${boldness}/10. Length: ${length}.
End with HASHTAGS: #tag1 #tag2 #tag3 on the last line. Start the post immediately.`,
          },
          {
            role: 'user',
            content: `Content pillar: ${pillar.pillar_name || day.theme || 'General'}
Post type: ${day.post_type || 'linkedin_post'}
Topic: ${day.topic}
Write the LinkedIn post now:`,
          },
        ],
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const raw = groqRes.data.choices[0].message.content.trim();
    const hashtagMatch = raw.match(/HASHTAGS:\s*(.+)$/m);
    const hashtags = hashtagMatch ? hashtagMatch[1].split(/\s+/).filter((h) => h.startsWith('#')) : [];
    const body = hashtagMatch ? raw.slice(0, hashtagMatch.index).trim() : raw;

    const postResult = await query(
      `INSERT INTO posts (id, user_id, pillar_id, type, topic, body, hashtags, status, source, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, 'draft', 'calendar', NOW(), NOW())
       RETURNING *`,
      [userId, pillarId, day.post_type || 'linkedin_post', day.topic, body, hashtags]
    );

    res.json({ post: postResult.rows[0] });
  } catch (err) {
    console.error('[POST /calendar/:id/generate-post]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate post from calendar' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = router;
