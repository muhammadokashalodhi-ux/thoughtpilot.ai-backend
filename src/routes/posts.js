const express         = require('express');
const router          = express.Router();
const { query }       = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkLimit }  = require('../middleware/plan');
const axios           = require('axios');

// ─── Generate a post via Groq ────────────────────────────────────────────────
router.post('/generate', requireAuth, checkLimit('posts_per_month'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      pillar_id,
      topic,
      tone               = 'authentic',
      length             = 'medium',
      type               = 'linkedin_post',
      sector_context     = [],
      source             = 'manual',
      trend_topic,
      skip_profile_check = false,
      no_personal_claims = false,
      save_only          = false,
      body:     prebuilt_body,
      hashtags: prebuilt_hashtags,
      status:   prebuilt_status = 'draft',
    } = req.body;

    // ── Save-only mode (user edited post and is saving it) ─────────────────
    if (save_only && prebuilt_body) {
      const result = await query(
        `INSERT INTO posts
           (id, user_id, pillar_id, type, topic, body, hashtags, status, source, sector_context, created_at, updated_at)
         VALUES
           (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
         RETURNING *`,
        [
          userId,
          pillar_id || null,
          type,
          topic || trend_topic || '',
          prebuilt_body,
          prebuilt_hashtags || [],
          prebuilt_status,
          source,
          sector_context,
        ]
      );
      return res.json({ post: result.rows[0] });
    }

    // ── Load full profile for context ──────────────────────────────────────
    const profileResult = await query(
      `SELECT full_name, user_role, years_experience, user_headline,
              sectors, companies, countries, achievements,
              credentials, about_summary, projects, awards,
              voice_boldness, voice_tone, post_length, style_notes, location
       FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found. Please complete onboarding.' });
    }

    const profile = profileResult.rows[0];

    // ── Load pillar if provided ────────────────────────────────────────────
    let pillar = null;
    if (pillar_id) {
      const pillarResult = await query(
        `SELECT pillar_name, description, prompt FROM pillars WHERE id = $1 AND user_id = $2`,
        [pillar_id, userId]
      );
      pillar = pillarResult.rows[0] || null;
    }

    if (!pillar && !trend_topic && !topic) {
      return res.status(400).json({ error: 'pillar_id or topic is required' });
    }

    // ── Build full profile context string ──────────────────────────────────
    const sectors = Array.isArray(profile.sectors)
      ? profile.sectors.join(', ')
      : (profile.sectors ? Object.keys(profile.sectors).join(', ') : '');

    const profileContext = [
      profile.full_name        && `Name: ${profile.full_name}`,
      profile.user_role        && `Role: ${profile.user_role}`,
      profile.user_headline    && `Headline: ${profile.user_headline}`,
      profile.years_experience && `Years of experience: ${profile.years_experience}`,
      profile.location         && `Location: ${profile.location}`,
      sectors                  && `Industry sectors: ${sectors}`,
      profile.companies        && `Companies worked at: ${profile.companies}`,
      profile.countries        && `Countries worked in: ${profile.countries}`,
      profile.achievements     && `Achievements: ${profile.achievements}`,
      profile.credentials      && `Credentials/Certifications: ${profile.credentials}`,
      profile.projects         && `Notable projects: ${profile.projects}`,
      profile.awards           && `Awards: ${profile.awards}`,
      profile.about_summary    && `About / Bio: ${profile.about_summary.substring(0, 800)}`,
    ].filter(Boolean).join('\n');

    const hasProfileData = profileContext.trim().length > 50;

    // ── Profile relevance check ────────────────────────────────────────────
    // If user's profile doesn't cover the pillar topic, warn before generating
    if (!skip_profile_check && !no_personal_claims && pillar) {
      const pillarKeywords = (pillar.pillar_name + ' ' + (pillar.description || '')).toLowerCase();
      const profileLower   = profileContext.toLowerCase();

      const stopWords = new Set([
        'and','the','for','with','from','that','this','are','have','has','been',
        'will','would','could','should','about','into','through','during','before',
        'after','above','below','each','our','your','their','they','what','when',
        'where','which','while','more','also','than','then',
      ]);

      const pillarWords = pillarKeywords
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));

      const matchCount = pillarWords.filter(w => profileLower.includes(w)).length;
      const matchRatio = pillarWords.length > 0 ? matchCount / pillarWords.length : 1;

      if (matchRatio < 0.25 && hasProfileData) {
        return res.json({
          warning: `Your profile doesn't have information about "${pillar.pillar_name}". Without relevant profile data, the AI would have to fabricate personal experience — which we won't do. You can proceed with a general informational post, or update your profile first for a more personalised result.`,
        });
      }
    }

    // ── Build prompts ──────────────────────────────────────────────────────
    const postTopic = trend_topic || topic || pillar?.pillar_name || 'professional insights';
    const isTrend   = source === 'trend' || !!trend_topic;

    const systemPrompt = buildSystemPrompt(profile, tone, length, no_personal_claims, profileContext, hasProfileData);
    const userPrompt   = buildUserPrompt({ pillar, topic, postTopic, isTrend, no_personal_claims, hasProfileData, profileContext, sector_context, sectors });

    // ── Call Groq ──────────────────────────────────────────────────────────
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1200,
        temperature: tone === 'authentic' || tone === 'storytelling' ? 0.78 : 0.65,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const raw = groqRes.data.choices[0].message.content.trim();
    const { body, hashtags } = parsePostResponse(raw);

    // ── Save to DB ─────────────────────────────────────────────────────────
    const insertResult = await query(
      `INSERT INTO posts
         (id, user_id, pillar_id, type, topic, body, hashtags, status, source, sector_context, created_at, updated_at)
       VALUES
         (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, 'draft', $7, $8, NOW(), NOW())
       RETURNING *`,
      [userId, pillar_id || null, type, postTopic, body, hashtags, source, sector_context]
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
                sectors, companies, countries, achievements,
                credentials, about_summary, projects, awards,
                voice_boldness, voice_tone, post_length, style_notes, location
         FROM profiles WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT pillar_name, description, prompt FROM pillars WHERE id = $1`,
        [post.pillar_id]
      ),
    ]);

    const profile = profileResult.rows[0];
    const pillar  = pillarResult.rows[0] || { pillar_name: 'General', description: '', prompt: '' };

    const sectors = Array.isArray(profile.sectors)
      ? profile.sectors.join(', ')
      : (profile.sectors ? Object.keys(profile.sectors).join(', ') : '');

    const profileContext = [
      profile.full_name        && `Name: ${profile.full_name}`,
      profile.user_role        && `Role: ${profile.user_role}`,
      profile.user_headline    && `Headline: ${profile.user_headline}`,
      profile.years_experience && `Years of experience: ${profile.years_experience}`,
      profile.location         && `Location: ${profile.location}`,
      sectors                  && `Industry sectors: ${sectors}`,
      profile.companies        && `Companies worked at: ${profile.companies}`,
      profile.countries        && `Countries worked in: ${profile.countries}`,
      profile.achievements     && `Achievements: ${profile.achievements}`,
      profile.credentials      && `Credentials/Certifications: ${profile.credentials}`,
      profile.projects         && `Notable projects: ${profile.projects}`,
      profile.awards           && `Awards: ${profile.awards}`,
      profile.about_summary    && `About / Bio: ${profile.about_summary.substring(0, 800)}`,
    ].filter(Boolean).join('\n');

    const systemPrompt = buildSystemPrompt(profile, 'authentic', 'medium', false, profileContext, true);
    const userPrompt   = buildUserPrompt({
      pillar,
      topic:          post.topic,
      postTopic:      post.topic,
      isTrend:        post.source === 'trend',
      no_personal_claims: false,
      hasProfileData: profileContext.length > 50,
      profileContext,
      sector_context: post.sector_context || [],
      sectors,
      regenerate:     true,
    });

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1200,
        temperature: 0.9, // higher for variation
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
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
    const params  = [];

    if (body     !== undefined) { params.push(body);     updates.push(`body = $${params.length}`); }
    if (hashtags !== undefined) { params.push(hashtags); updates.push(`hashtags = $${params.length}`); }
    if (topic    !== undefined) { params.push(topic);    updates.push(`topic = $${params.length}`); }
    if (status   !== undefined) {
      params.push(status);
      updates.push(`status = $${params.length}`);
      if (status === 'approved') updates.push(`approved_at = NOW()`);
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

function buildSystemPrompt(profile, tone, length, noPersonalClaims, profileContext, hasProfileData) {
  const boldness   = profile.voice_boldness || 5;
  const voiceTone  = profile.voice_tone     || tone || 'professional';
  const postLength = profile.post_length    || length || 'medium';

  const lengthGuide = {
    short:  '80–120 words',
    medium: '150–250 words',
    long:   '300–400 words',
  }[postLength] || '150–250 words';

  const toneGuide = {
    authentic:    'First person, honest and personal. Real feelings, real moments.',
    insightful:   'Thought leader. Share analysis, patterns, professional perspective.',
    storytelling: 'Open with a specific scene or moment. Build tension, reveal the lesson.',
    educational:  'Practical, actionable knowledge. Examples, clear structure.',
    motivational: 'Inspire action. Connect professional challenge to broader human truth.',
  }[tone] || 'First person, honest and authentic.';

  // ── CRITICAL honesty rules — the core of this update ──────────────────
  const honestyRules = noPersonalClaims ? `
═══ CRITICAL RULES — MUST FOLLOW ═══
1. DO NOT write in first person claiming personal experience. The user's profile data does NOT cover this topic.
2. DO NOT use "I have worked with...", "In my experience...", "I once..." — there is no profile data to support it.
3. Write as GENERAL THOUGHT LEADERSHIP. Use "we", "many professionals", "teams in this field", etc.
4. You CAN reference industry trends, research, frameworks, and observations.
5. NO fake metrics, NO made-up company names, NO invented scenarios.
6. Better to write a shorter honest post than a longer fabricated one.
═══════════════════════════════════` : `
═══ CRITICAL RULES — MUST FOLLOW ═══
1. ONLY use personal details, companies, achievements, and numbers EXPLICITLY mentioned in the PROFILE DATA below.
2. DO NOT invent, assume, or hallucinate ANY personal experience, metric, company name, or story.
3. If the profile does not mention a specific detail, do NOT make it up — omit it or write more generally.
4. Do NOT say "In my X years..." unless the profile explicitly states the number.
5. Do NOT name companies the profile does not mention.
6. A shorter honest post beats a longer fabricated one every time.
═══════════════════════════════════`;

  return `You are a professional LinkedIn ghostwriter for ${profile.full_name || 'a professional'}.

AUTHOR PROFILE:
- Name: ${profile.full_name || 'the author'}
- Role: ${profile.user_role || 'Professional'}
- Headline: ${profile.user_headline || ''}
- Experience: ${profile.years_experience || ''}+ years
- Location: ${profile.location || ''}
- Sectors: ${Array.isArray(profile.sectors) ? profile.sectors.join(', ') : ''}
- Credentials: ${profile.credentials || ''}

${honestyRules}

VOICE:
- Boldness: ${boldness}/10 (${boldness >= 7 ? 'direct, bold, take strong stances' : boldness >= 4 ? 'balanced and confident' : 'measured and diplomatic'})
- Tone style: ${toneGuide}
- Style notes: ${profile.style_notes || 'none'}

OUTPUT FORMAT:
- Length: ${lengthGuide}
- No preamble or commentary — start the post immediately
- Use line breaks naturally (LinkedIn is read on mobile)
- End with a blank line then: HASHTAGS: #tag1 #tag2 #tag3 #tag4 #tag5`;
}

function buildUserPrompt({ pillar, topic, postTopic, isTrend, no_personal_claims, hasProfileData, profileContext, sector_context, sectors, regenerate }) {
  const profileSection = hasProfileData && !no_personal_claims
    ? `\nUSE ONLY THIS PROFILE DATA — do not invent anything beyond it:\n${profileContext}\n`
    : `\nNo personal profile data available for this topic — write a general professional post without personal claims.\n`;

  const pillarSection = pillar
    ? `CONTENT PILLAR: ${pillar.pillar_name}\nPILLAR DESCRIPTION: ${pillar.description || ''}\nPILLAR GUIDANCE: ${pillar.prompt || ''}\n`
    : '';

  const trendNote = isTrend
    ? `This is a TREND-BASED post. If there is a genuine personal connection in the profile data, use it. If not, write a general insightful take on the trend.\n`
    : '';

  return `${regenerate ? 'Write a COMPLETELY DIFFERENT version of this LinkedIn post — different angle, different opening, different structure.\n\n' : ''}${pillarSection}TOPIC: ${postTopic}
${topic && topic !== postTopic ? `USER DIRECTION: "${topic}"\n` : ''}${trendNote}SECTOR CONTEXT: ${sector_context?.length ? sector_context.join(', ') : sectors || 'general'}
${profileSection}
Write the LinkedIn post now:`;
}

function parsePostResponse(raw) {
  const hashtagMatch = raw.match(/HASHTAGS:\s*(.+)$/m);
  let hashtags = [];
  let body     = raw;

  if (hashtagMatch) {
    hashtags = hashtagMatch[1]
      .split(/\s+/)
      .map(h => h.trim())
      .filter(h => h.startsWith('#'));
    body = raw.slice(0, hashtagMatch.index).trim();
  } else {
    // Fallback: extract inline hashtags from end of post
    const lines    = raw.split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine && lastLine.includes('#')) {
      hashtags = lastLine.match(/#\w+/g) || [];
      body     = lines.slice(0, -1).join('\n').trim();
    }
  }

  return { body, hashtags };
}

// ─── Generate hook alternatives for a post ───────────────────────────────────
router.post('/generate-hooks', requireAuth, async (req, res) => {
  try {
    const { post_body } = req.body;
    if (!post_body || !post_body.trim()) {
      return res.status(400).json({ error: 'post_body is required' });
    }

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.1-8b-instant',
        max_tokens:  600,
        temperature: 0.85,
        messages: [
          {
            role: 'system',
            content: `You are a LinkedIn hook writer. Generate 4 alternative opening lines (hooks) for a LinkedIn post.
Each hook must be attention-grabbing, punchy, and under 20 words.
Use a different style for each: Question, Bold Statement, Contrarian, and Story/Scene.

Respond ONLY in this exact JSON format — no preamble, no markdown, no extra text:
[
  { "style": "Question", "text": "..." },
  { "style": "Bold Statement", "text": "..." },
  { "style": "Contrarian", "text": "..." },
  { "style": "Story/Scene", "text": "..." }
]`,
          },
          {
            role: 'user',
            content: `Here is the LinkedIn post. Generate 4 alternative opening hooks for it:\n\n${post_body.substring(0, 1500)}`,
          },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const raw = groqRes.data.choices[0].message.content.trim();

    let hooks = [];
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      hooks = JSON.parse(clean);
    } catch {
      // Fallback: return empty hooks rather than crashing
      return res.status(500).json({ error: 'Failed to parse hook response' });
    }

    res.json({ hooks });
  } catch (err) {
    console.error('[POST /posts/generate-hooks]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate hooks' });
  }
});

// ─── Generate author comment for a post ──────────────────────────────────────
router.post('/generate-author-comment', requireAuth, async (req, res) => {
  try {
    const userId     = req.user.id;
    const { post_body } = req.body;

    if (!post_body || !post_body.trim()) {
      return res.status(400).json({ error: 'post_body is required' });
    }

    // Load profile for personalisation
    const profileResult = await query(
      `SELECT full_name, user_role, years_experience, user_headline, sectors
       FROM profiles WHERE user_id = $1`,
      [userId]
    );
    const profile = profileResult.rows[0] || {};

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.1-8b-instant',
        max_tokens:  300,
        temperature: 0.75,
        messages: [
          {
            role: 'system',
            content: `You are a LinkedIn strategy expert. Write a first author comment that the post author should post immediately under their own LinkedIn post to boost reach and engagement.

The comment should:
- Add a key insight, behind-the-scenes detail, or personal thought NOT already in the post
- Be 2–4 sentences max
- Feel natural, not promotional
- Invite engagement (e.g. end with a question or "curious what you think")
- NOT start with "Great post" or self-congratulatory phrases

Author: ${profile.full_name || 'the author'}, ${profile.user_role || 'professional'}

Respond with ONLY the comment text — no quotes, no labels, no explanation.`,
          },
          {
            role: 'user',
            content: `Write the author comment for this LinkedIn post:\n\n${post_body.substring(0, 1500)}`,
          },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const comment = groqRes.data.choices[0].message.content.trim();
    res.json({ comment });
  } catch (err) {
    console.error('[POST /posts/generate-author-comment]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate author comment' });
  }
});

module.exports = router;
