const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');

// ─── Generate a post via Groq ────────────────────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pillar_id, topic, type = 'linkedin_post', sector_context = [] } = req.body;

    if (!pillar_id || !topic) {
      return res.status(400).json({ error: 'pillar_id and topic are required' });
    }

    // Load user profile + pillar in parallel
    const [profileResult, pillarResult] = await Promise.all([
      query(
        `SELECT full_name, user_role, years_experience, user_headline,
                sectors, voice_boldness, voice_tone, post_length, style_notes, credentials
         FROM profiles WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT pillar_name, description, prompt FROM pillars
         WHERE id = $1 AND user_id = $2`,
        [pillar_id, userId]
      ),
    ]);

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found. Please complete onboarding.' });
    }
    if (!pillarResult.rows.length) {
      return res.status(404).json({ error: 'Content pillar not found.' });
    }

    const profile = profileResult.rows[0];
    const pillar = pillarResult.rows[0];

    // Build the prompt
    const systemPrompt = buildSystemPrompt(profile);
    const userPrompt = buildUserPrompt({ profile, pillar, topic, type, sector_context });

    // Call Groq
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        temperature: 0.82,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
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

    // Parse body + hashtags from the response
    const { body, hashtags } = parsePostResponse(raw);

    // Save as draft to posts table
    const insertResult = await query(
      `INSERT INTO posts
         (id, user_id, pillar_id, type, topic, body, hashtags, status, source, sector_context, created_at, updated_at)
       VALUES
         (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, 'draft', 'ai_generated', $7, NOW(), NOW())
       RETURNING *`,
      [userId, pillar_id, type, topic, body, hashtags, sector_context]
    );

    res.json({ post: insertResult.rows[0] });
  } catch (err) {
    console.error('[POST /posts/generate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate post' });
  }
});

// ─── Regenerate (replace body of existing draft) ────────────────────────────
router.post('/regenerate/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Fetch the existing post
    const postResult = await query(
      `SELECT * FROM posts WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!postResult.rows.length) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    const post = postResult.rows[0];

    const [profileResult, pillarResult] = await Promise.all([
      query(
        `SELECT full_name, user_role, years_experience, user_headline,
                sectors, voice_boldness, voice_tone, post_length, style_notes, credentials
         FROM profiles WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT pillar_name, description, prompt FROM pillars WHERE id = $1`,
        [post.pillar_id]
      ),
    ]);

    const profile = profileResult.rows[0];
    const pillar = pillarResult.rows[0] || { pillar_name: 'General', description: '', prompt: '' };

    const systemPrompt = buildSystemPrompt(profile);
    const userPrompt = buildUserPrompt({
      profile,
      pillar,
      topic: post.topic,
      type: post.type,
      sector_context: post.sector_context || [],
      regenerate: true,
    });

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        temperature: 0.9, // higher for variation
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
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
    const { body, hashtags } = parsePostResponse(raw);

    const updated = await query(
      `UPDATE posts SET body = $1, hashtags = $2, updated_at = NOW()
       WHERE id = $3 AND user_id = $4 RETURNING *`,
      [body, hashtags, id, userId]
    );

    res.json({ post: updated.rows[0] });
  } catch (err) {
    console.error('[POST /posts/regenerate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to regenerate post' });
  }
});

// ─── List posts (drafts / queue / approved / scheduled) ─────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, limit = 50, offset = 0 } = req.query;

    let queryStr = `
      SELECT p.*, pi.pillar_name, pi.pillar_icon
      FROM posts p
      LEFT JOIN pillars pi ON pi.id = p.pillar_id
      WHERE p.user_id = $1
    `;
    const params = [userId];

    if (status) {
      params.push(status);
      queryStr += ` AND p.status = $${params.length}`;
    }

    queryStr += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    // Count totals per status
    const countResult = await query(
      `SELECT status, COUNT(*) as count FROM posts WHERE user_id = $1 GROUP BY status`,
      [userId]
    );
    const counts = {};
    countResult.rows.forEach((r) => { counts[r.status] = parseInt(r.count); });

    res.json({ posts: result.rows, counts });
  } catch (err) {
    console.error('[GET /posts]', err.message);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ─── Get single post ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await query(
      `SELECT p.*, pi.pillar_name, pi.pillar_icon
       FROM posts p LEFT JOIN pillars pi ON pi.id = p.pillar_id
       WHERE p.id = $1 AND p.user_id = $2`,
      [id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// ─── Update post (edit body, change status, approve, schedule) ───────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { body, hashtags, status, topic } = req.body;

    const existing = await query(
      `SELECT * FROM posts WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Post not found' });

    const updates = [];
    const params = [];

    if (body !== undefined) { params.push(body); updates.push(`body = $${params.length}`); }
    if (hashtags !== undefined) { params.push(hashtags); updates.push(`hashtags = $${params.length}`); }
    if (topic !== undefined) { params.push(topic); updates.push(`topic = $${params.length}`); }
    if (status !== undefined) {
      params.push(status);
      updates.push(`status = $${params.length}`);
      if (status === 'approved') {
        updates.push(`approved_at = NOW()`);
      }
    }

    updates.push(`updated_at = NOW()`);
    params.push(id, userId);

    const result = await query(
      `UPDATE posts SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params
    );

    res.json({ post: result.rows[0] });
  } catch (err) {
    console.error('[PATCH /posts/:id]', err.message);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// ─── Delete post ─────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    await query(`DELETE FROM posts WHERE id = $1 AND user_id = $2`, [id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const boldness = profile.voice_boldness || 5;
  const tone = profile.voice_tone || 'professional';
  const length = profile.post_length || 'medium';

  const lengthGuide = {
    short: '150–250 words',
    medium: '250–400 words',
    long: '400–600 words',
  }[length] || '250–400 words';

  return `You are a world-class LinkedIn ghostwriter for  senior professionals across any industry.

AUTHOR CONTEXT:
- Name: ${profile.full_name || 'the author'}
- Role: ${profile.user_role || 'Professional'}
- Industries / Sectors: ${Array.isArray(profile.sectors) ? profile.sectors.join(', ') : 'general'}
- Experience: ${profile.years_experience || '10'}+ years
- Headline: ${profile.user_headline || ''}
- Credentials: ${profile.credentials || ''}

VOICE SETTINGS:
- Boldness: ${boldness}/10 (${boldness >= 7 ? 'be direct, bold, take strong stances' : boldness >= 4 ? 'balanced and confident' : 'measured, careful, diplomatic'})
- Tone: ${tone}
- Style notes: ${profile.style_notes || 'none'}

OUTPUT FORMAT:
Write a LinkedIn post of ${lengthGuide}.
End with a blank line then 3–5 relevant hashtags on a single line starting with HASHTAGS:
Do NOT include any preamble, commentary, or labels — start the post immediately.`;
}

function buildUserPrompt({ profile, pillar, topic, type, sector_context, regenerate }) {
  const sectors = Array.isArray(profile.sectors)
    ? profile.sectors.join(', ')
    : JSON.stringify(profile.sectors || []);

  return `${regenerate ? 'Write a DIFFERENT version of this LinkedIn post.\n\n' : ''}CONTENT PILLAR: ${pillar.pillar_name}
PILLAR DESCRIPTION: ${pillar.description || ''}
PILLAR PROMPT GUIDANCE: ${pillar.prompt || ''}

TOPIC: ${topic}
POST TYPE: ${type}
SECTOR CONTEXT: ${sector_context.length ? sector_context.join(', ') : sectors}

Write the post now:`;
}

function parsePostResponse(raw) {
  const hashtagMatch = raw.match(/HASHTAGS:\s*(.+)$/m);
  let hashtags = [];
  let body = raw;

  if (hashtagMatch) {
    hashtags = hashtagMatch[1]
      .split(/\s+/)
      .map((h) => h.trim())
      .filter((h) => h.startsWith('#'));
    body = raw.slice(0, hashtagMatch.index).trim();
  } else {
    // Extract inline hashtags from end of post
    const lines = raw.split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine && lastLine.includes('#')) {
      hashtags = lastLine.match(/#\w+/g) || [];
      body = lines.slice(0, -1).join('\n').trim();
    }
  }

  return { body, hashtags };
}

module.exports = router;
