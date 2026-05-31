  const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkLimit, incrementUsage } = require('../middleware/plan');
const axios = require('axios');

// ─── POST /api/comments/generate ─────────────────────────────────────────────
// Generate a LinkedIn comment in the user's voice
router.post('/generate', requireAuth, checkLimit('comments_per_day'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { post_text, post_author, post_context, comment_intent = 'add_value', tone_override } = req.body;

    if (!post_text) return res.status(400).json({ error: 'post_text is required' });

    // ── Org mode branch ──────────────────────────────────────────────────
    if (req.user.account_type === 'organisation' && process.env.ORG_MODE_ENABLED === 'true') {
      return generateOrgComment(req, res);
    }

    const profileResult = await query(
      `SELECT full_name, user_role, years_experience, user_headline,
              sectors, voice_boldness, voice_tone, style_notes, credentials
       FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found. Please complete onboarding.' });
    }

    const profile = profileResult.rows[0];
    const tone = tone_override || profile.voice_tone || 'professional';
    const boldness = profile.voice_boldness || 5;

    const systemPrompt = `You are a LinkedIn ghostwriter helping a senior professional craft authentic, high-value comments in their industry voice.

AUTHOR PROFILE:
- Name: ${profile.full_name || 'the author'}
- Role: ${profile.user_role || 'Professional'}
- Industries: ${Array.isArray(profile.sectors) ? profile.sectors.join(', ') : 'general'}
- Experience: ${profile.years_experience || '10'}+ years
- Credentials: ${profile.credentials || ''}

VOICE:
- Tone: ${tone}
- Boldness: ${boldness}/10

COMMENT RULES:
- Sound human, not corporate
- Add genuine value — insight, experience, or a thoughtful question
- Never sycophantic ("Great post!" openers are banned)
- Max 3 sentences unless the intent demands more
- Match the intent exactly

Output ONLY the comment text. No preamble, no label, no quotes.`;

    const intentGuide = {
      add_value: 'Add a unique insight or perspective from your professioanl experience that extends the post.',
      agree_expand: 'Agree with the post and add a complementary point or real-world example.',
      disagree_respectfully: 'Respectfully offer a different perspective or nuance the author may have missed.',
      ask_question: 'Ask a genuinely curious, intelligent question that deepens the conversation.',
      share_experience: 'Share a brief, relevant personal experience or case from your career.',
      congratulate: 'Offer a warm, specific, non-generic congratulation that references what they actually achieved.',
    };

    const intentMap = {
      add_value: 'Add_Value',
      agree_expand: 'Agree_&_Expand',
      disagree_respectfully: 'Respectful_Disagreement',
      ask_question: 'Ask_Question',
      share_experience: 'Share_Experience',
      congratulate: 'Congratulate',
    };

    const userPrompt = `POST${post_author ? ` by ${post_author}` : ''}:
"${post_text}"
${post_context ? `\nAdditional context: ${post_context}` : ''}

COMMENT INTENT: ${intentMap[comment_intent] || comment_intent}
INSTRUCTION: ${intentGuide[comment_intent] || intentGuide.add_value}

Write the comment now:`;

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 300,
        temperature: 0.78,
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
        timeout: 20000,
      }
    );

    const comment = groqRes.data.choices[0].message.content.trim();

    await incrementUsage(userId, 'comments_per_day');

    res.json({ comment, intent: comment_intent, tone });
  } catch (err) {
    console.error('[POST /comments/generate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate comment' });
  }
});

// ─── POST /api/comments/variations ───────────────────────────────────────────
// Generate 3 variations of a comment at once
router.post('/variations', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { post_text, post_author, comment_intent = 'add_value' } = req.body;

    if (!post_text) return res.status(400).json({ error: 'post_text is required' });

    const profileResult = await query(
      `SELECT full_name, user_role, years_experience, voice_boldness, voice_tone, style_notes
       FROM profiles WHERE user_id = $1`,
      [userId]
    );

    const profile = profileResult.rows[0] || {};

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 700,
        temperature: 0.88,
        messages: [
          {
            role: 'system',
            content: `You are a LinkedIn ghostwriter. Generate exactly 3 distinct comment variations for a senior professional named ${profile.full_name || 'the author'}, ${profile.user_role || 'Industry leader'}.
Each variation should have a different angle or opening style but same intent.
Output ONLY valid JSON: { "variations": ["comment1", "comment2", "comment3"] }
No preamble, no markdown, no extra text.`,
          },
          {
            role: 'user',
            content: `POST${post_author ? ` by ${post_author}` : ''}:\n"${post_text}"\n\nIntent: ${comment_intent}\nGenerate 3 variations:`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );

    const raw = groqRes.data.choices[0].message.content.trim();
    let variations;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      variations = JSON.parse(cleaned).variations;
    } catch {
      variations = [raw];
    }

    res.json({ variations });
  } catch (err) {
    console.error('[POST /comments/variations]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate variations' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// ORG MODE — Comment generation in brand voice
// ═══════════════════════════════════════════════════════════════════════════

async function generateOrgComment(req, res) {
  const userId = req.user.id;
  const { post_text, post_author, post_context, comment_intent = 'add_value', tone_override } = req.body;

  if (!post_text) return res.status(400).json({ error: 'post_text is required' });

  try {
    const orgResult = await query(
      `SELECT o.* FROM organisations o
       JOIN org_members m ON m.org_id = o.id
       WHERE m.user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!orgResult.rows.length) {
      return res.status(404).json({ error: 'Organisation profile not found' });
    }

    const org = orgResult.rows[0];

    const brandVoiceDesc = {
      professional:  'authoritative and credible — clear, direct, industry expert',
      friendly:      'warm and human — conversational, uses "we" naturally',
      authoritative: 'confident thought leader — takes clear stances',
      innovative:    'forward-thinking and energetic',
    };

    const intentGuide = {
      add_value:             'Add a unique company insight or industry perspective that extends the post.',
      agree_expand:          'Agree and add a complementary point from the company perspective.',
      disagree_respectfully: 'Respectfully offer a different industry perspective.',
      ask_question:          'Ask a genuinely curious, intelligent question as the company.',
      share_experience:      'Share a relevant company experience or client case briefly.',
      congratulate:          'Offer a warm, specific, non-generic congratulation.',
    };

    const systemPrompt = `You are writing a LinkedIn comment on behalf of ${org.company_name}, a ${org.org_type || 'company'} in ${org.industry || 'the industry'}.

COMPANY:
- Name: ${org.company_name}
- Industry: ${org.industry || 'not specified'}
- Brand voice: ${brandVoiceDesc[org.brand_voice || 'professional']}
- Target audience: ${org.target_audience || 'industry professionals'}

COMMENT RULES:
- Write as the company — use "we", "our team", "at ${org.company_name}"
- NEVER use "I" — this is a company account
- Sound human and genuine — not like a PR statement
- Max 3 sentences unless the intent demands more
- Never start with "Great post!" or sycophantic openers
- Add genuine value

Output ONLY the comment text. No preamble, no labels, no quotes.`;

    const userPrompt = `POST${post_author ? ` by ${post_author}` : ''}:
"${post_text}"
${post_context ? `Additional context: ${post_context}` : ''}

COMMENT INTENT: ${comment_intent}
INSTRUCTION: ${intentGuide[comment_intent] || intentGuide.add_value}

Write the comment now:`;

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.1-8b-instant',
        max_tokens:  300,
        temperature: 0.75,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    const comment = groqRes.data.choices[0].message.content.trim();
    res.json({ comment, intent: comment_intent, mode: 'organisation' });

  } catch (err) {
    console.error('[ORG /comments/generate]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate comment' });
  }
}

module.exports = router;
