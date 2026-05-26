'use strict';

const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const crypto       = require('crypto');
const { query }    = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── GET /api/career/handoff ──────────────────────────────────────────────────
// Returns user + profile + cv_prefill for the Career Suite frontend
router.get('/handoff', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         u.id, u.email, u.full_name, u.plan, u.is_beta, u.is_admin,
         u.onboarding_complete,
         p.user_role, p.sectors, p.location, p.voice_tone,
         p.years_experience, p.user_headline, p.companies,
         p.achievements, p.credentials, p.about_summary AS cv_prefill,
         p.cv_analysis_cache, p.cv_analysis_hash, p.cv_analyzed_at
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const row = rows[0];
    res.json({
      user: {
        id:                  row.id,
        email:               row.email,
        full_name:           row.full_name,
        plan:                row.plan,
        is_beta:             row.is_beta,
        is_admin:            row.is_admin,
        onboarding_complete: row.onboarding_complete,
      },
      profile: {
        user_role:       row.user_role,
        sectors:         row.sectors,
        location:        row.location,
        voice_tone:      row.voice_tone,
        years_experience:row.years_experience,
        user_headline:   row.user_headline,
        companies:       row.companies,
        achievements:    row.achievements,
        credentials:     row.credentials,
      },
      cv_prefill: row.cv_prefill || null,
    });
  } catch (err) {
    console.error('[career] handoff error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/career/analyze-cv ─────────────────────────────────────────────
// Proxies to Groq — expects { messages: [...] }
// Includes: CV hash caching, token logging, rate limit handling
router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    console.log(`[career] analyze-cv — user ${req.user.id} — ${messages.length} messages`);

    // ── CV hash cache — skip Groq if same CV analyzed recently ──────────────
    const userMsg = messages.find(m => m.role === 'user');
    if (userMsg?.content) {
      const cvHash = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      const cached = await query(
        `SELECT cv_analysis_cache FROM profiles
         WHERE user_id = $1
           AND cv_analysis_hash = $2
           AND cv_analyzed_at > NOW() - INTERVAL '7 days'`,
        [req.user.id, cvHash]
      ).catch(() => ({ rows: [] }));

      if (cached.rows[0]?.cv_analysis_cache) {
        console.log(`[career] ✅ Cache hit for user ${req.user.id} — skipping Groq call`);
        return res.json(cached.rows[0].cv_analysis_cache);
      }
    }

    // ── Call Groq ────────────────────────────────────────────────────────────
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:           'llama-3.3-70b-versatile',
        max_tokens:      4096,
        temperature:     0.3,
        messages,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
      }
    );

    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      console.error('[career] analyze-cv — empty content from Groq');
      return res.status(500).json({ error: 'Empty response from AI — please retry' });
    }

    // ── Log token usage ──────────────────────────────────────────────────────
    const usage = groqRes.data?.usage;
    if (usage) {
      console.log(`[career] tokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
      if (usage.total_tokens > 7000) {
        console.warn(`[career] ⚠️ High token usage: ${usage.total_tokens}`);
      }
    }

    // ── Save to cache ────────────────────────────────────────────────────────
    if (userMsg?.content) {
      const cvHash = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      await query(
        `UPDATE profiles
         SET cv_analysis_cache = $1,
             cv_analysis_hash  = $2,
             cv_analyzed_at    = NOW()
         WHERE user_id = $3`,
        [JSON.stringify(groqRes.data), cvHash, req.user.id]
      ).catch(e => console.warn('[career] cache save failed:', e.message));
    }

    res.json(groqRes.data);

  } catch (err) {
    const status  = err?.response?.status;
    const errData = err?.response?.data;
    console.error(`[career] analyze-cv error — status: ${status}`, errData || err.message);
    if (status === 429)
      return res.status(429).json({ error: 'Rate limit reached — please wait 30 seconds and retry' });
    if (status === 413 || err?.message?.includes('context'))
      return res.status(413).json({ error: 'CV is too long for analysis — please shorten it and retry' });
    res.status(500).json({ error: errData?.error?.message || err.message || 'Analysis failed — please retry' });
  }
});

// ─── POST /api/career/analyze-job ────────────────────────────────────────────
// Proxies to Groq — expects { messages: [...] }
router.post('/analyze-job', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:           'llama-3.3-70b-versatile',
        max_tokens:      2048,
        temperature:     0.3,
        messages,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    res.json(groqRes.data);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-job error:', err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data?.error?.message || err.message || 'Job match failed' });
  }
});

// ─── POST /api/career/cover-letter ───────────────────────────────────────────
router.post('/cover-letter', requireAuth, async (req, res) => {
  try {
    const { cv_text, job_description, user_name, user_role, approved_suggestions } = req.body;
    if (!cv_text || !job_description) {
      return res.status(400).json({ error: 'cv_text and job_description are required' });
    }
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1500,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: `You are an expert cover letter writer. Write a professional, personalized cover letter.
Format: 3–4 paragraphs. Tone: confident but not arrogant. Length: 300–400 words.
Do NOT use generic phrases like "I am writing to apply". Open with a strong hook.
Return ONLY the cover letter text — no subject line, no date, no address block.`,
          },
          {
            role: 'user',
            content: `Write a cover letter for ${user_name || 'the candidate'} (${user_role || 'professional'}).

CV SUMMARY:
${cv_text.slice(0, 3000)}

JOB DESCRIPTION:
${job_description.slice(0, 2000)}

${approved_suggestions?.length ? `APPROVED IMPROVEMENTS TO INCORPORATE:\n${approved_suggestions.slice(0, 5).join('\n')}` : ''}`,
          },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const cover_letter = groqRes.data?.choices?.[0]?.message?.content || '';
    if (!cover_letter) return res.status(500).json({ error: 'Failed to generate cover letter' });
    res.json({ cover_letter });
  } catch (err) {
    console.error('[career] cover-letter error:', err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data?.error?.message || err.message || 'Cover letter generation failed' });
  }
});

// ─── POST /api/career/save-cv ─────────────────────────────────────────────────
// Saves optimised CV text to profiles.about_summary
router.post('/save-cv', requireAuth, async (req, res) => {
  try {
    const { cv_text } = req.body;
    if (!cv_text) return res.status(400).json({ error: 'cv_text is required' });
    await query(
      `UPDATE profiles SET about_summary = $1 WHERE user_id = $2`,
      [cv_text, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[career] save-cv error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/career/status ───────────────────────────────────────────────────
// Feature gate check per plan
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.plan, u.is_beta, u.is_admin FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const { plan, is_beta, is_admin } = rows[0];
    res.json({
      enabled:    true,
      plan,
      is_beta,
      is_admin,
      features: {
        full_analysis:   is_beta || is_admin || plan === 'pro',
        job_match:       is_beta || is_admin || ['pro', 'starter'].includes(plan),
        cover_letter:    is_beta || is_admin || plan === 'pro',
        export_word:     is_beta || is_admin || plan === 'pro',
        export_pdf:      true,
        templates_all:   is_beta || is_admin || plan === 'pro',
      },
    });
  } catch (err) {
    console.error('[career] status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
