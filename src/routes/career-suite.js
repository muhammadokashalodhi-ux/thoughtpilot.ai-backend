'use strict';

const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const crypto       = require('crypto');
const { query }    = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLimitsForPlan } = require('../config/limits');

// ── Shared limit checker for Career Suite ─────────────────────────────────────
async function checkCareerLimit(userId, plan, isBeta, isAdmin, limitType) {
  if (isBeta || isAdmin) return null; // unlimited

  const dbQuery = query; // use already-imported query
  const limits = getLimitsForPlan(plan);

  // Ensure row exists
  await dbQuery(
    `INSERT INTO usage_tracking (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const today = new Date().toISOString().slice(0, 10);
  const r = await dbQuery(
    `SELECT cv_analyses_today, cv_day_reset_at, job_matches_today, job_day_reset_at
     FROM usage_tracking WHERE user_id = $1`,
    [userId]
  );
  const row = r.rows[0] || {};

  if (limitType === 'cv_analysis') {
    // Reset daily counter if it's a new day
    if (!row.cv_day_reset_at || row.cv_day_reset_at.toISOString().slice(0, 10) !== today) {
      await dbQuery(
        `UPDATE usage_tracking SET cv_analyses_today = 0, cv_day_reset_at = CURRENT_DATE WHERE user_id = $1`,
        [userId]
      );
      row.cv_analyses_today = 0;
    }
    const used  = row.cv_analyses_today || 0;
    const limit = limits.cv_analyses_per_day ?? 1;
    if (used >= limit) {
      return {
        error: 'Daily CV analysis limit reached',
        code:  'USAGE_LIMIT', limit_key: 'cv_analyses_per_day',
        used, limit, plan,
        upgrade_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
      };
    }
  }

  if (limitType === 'job_match') {
    if (!row.job_day_reset_at || row.job_day_reset_at.toISOString().slice(0, 10) !== today) {
      await dbQuery(
        `UPDATE usage_tracking SET job_matches_today = 0, job_day_reset_at = CURRENT_DATE WHERE user_id = $1`,
        [userId]
      );
      row.job_matches_today = 0;
    }
    const used  = row.job_matches_today || 0;
    const limit = limits.job_matches_per_day ?? 2;
    if (used >= limit) {
      return {
        error: 'Daily job match limit reached',
        code:  'USAGE_LIMIT', limit_key: 'job_matches_per_day',
        used, limit, plan,
        upgrade_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
      };
    }
  }

  return null; // no limit hit
}

async function incrementCareerUsage(userId, limitType) {
  const dbQuery = query; // use already-imported query
  try {
    if (limitType === 'cv_analysis') {
      await dbQuery(
        `UPDATE usage_tracking SET cv_analyses_today = cv_analyses_today + 1 WHERE user_id = $1`,
        [userId]
      );
    }
    if (limitType === 'job_match') {
      await dbQuery(
        `UPDATE usage_tracking SET job_matches_today = job_matches_today + 1 WHERE user_id = $1`,
        [userId]
      );
    }
  } catch (err) {
    console.error('[career] incrementCareerUsage failed:', err.message);
  }
}

// ─── Shared Groq caller with retry ──────────────────────────────────────────
// Model fallback chain — if primary hits daily limit, try next
const MODEL_CHAIN = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama-3.1-8b-instant',   // last resort — less accurate but separate quota
];

async function callGroq({ messages, model = 'llama-3.3-70b-versatile', maxTokens = 3000, temperature = 0.3 }) {
  // Build model chain starting from requested model
  const startIdx = MODEL_CHAIN.indexOf(model);
  const chain = startIdx >= 0
    ? MODEL_CHAIN.slice(startIdx)
    : [model, ...MODEL_CHAIN];

  for (const currentModel of chain) {
    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          { model: currentModel, max_tokens: maxTokens, temperature, messages, response_format: { type: 'json_object' } },
          {
            headers: { Authorization: `Bearer ${process.env.GROQ_CAREER_API_KEY || process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 90000,
          }
        );
        if (currentModel !== model) console.log(`[career/groq] Using fallback model: ${currentModel}`);
        return res;
      } catch (err) {
        const status  = err?.response?.status;
        const errCode = err?.response?.data?.error?.code;
        // TPD (daily) limit — skip to next model immediately, no point retrying
        if (status === 429 && errCode === 'rate_limit_exceeded' &&
            err?.response?.data?.error?.message?.includes('tokens per day')) {
          console.warn(`[career/groq] Daily limit hit for ${currentModel} — trying next model`);
          break; // break inner retry loop, try next model
        }
        // TPM (per-minute) limit — wait and retry same model
        if (status === 429 && attempt < MAX_RETRIES) {
          const waitMs = attempt * 10000;
          console.warn(`[career/groq] 429 TPM — waiting ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw err;
      }
    }
  }
  // All models exhausted
  throw { response: { status: 429, data: { error: { message: 'All models at daily limit. Resets at midnight UTC. Upgrade at console.groq.com/settings/billing', code: 'daily_limit_exhausted' } } } };
}

// ─── Gemini Flash caller (free tier — pattern matching tasks) ────────────────
async function callGemini({ messages, maxTokens = 2000, temperature = 0.1 }) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    console.warn('[career/gemini] No GEMINI_API_KEY — falling back to Groq');
    throw new Error('Gemini not configured');
  }

  // Convert OpenAI message format to Gemini format
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMsg   = messages.find(m => m.role === 'user')?.content   || '';

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      contents: [{
        parts: [{ text: `${systemMsg}

${userMsg}` }],
        role: 'user',
      }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',  // force JSON output
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  // Return in same shape as Groq so callers work identically
  return {
    data: {
      choices: [{ message: { content: text } }],
      usage: { total_tokens: res.data?.usageMetadata?.totalTokenCount || 0 },
    }
  };
}

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
         p.cv_analysis_cache, p.cv_analysis_hash, p.cv_analyzed_at,
         p.job_match_cache, p.job_match_hash, p.job_matched_at
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
      cv_prefill:         row.cv_prefill        || null,
      cv_analysis_cache:  row.cv_analysis_cache || null,
      cv_analyzed_at:     row.cv_analyzed_at    || null,
      job_match_cache:    row.job_match_cache   || null,
      job_matched_at:     row.job_matched_at    || null,
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
    const groqRes = await callGroq({ messages, model: 'llama-3.3-70b-versatile', maxTokens: 4096, temperature: 0.3 });

    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      console.error('[career] analyze-cv — empty content from Groq');
      return res.status(500).json({ error: 'Empty response from AI — please retry' });
    }

    // ── Increment usage counter ──────────────────────────────────────────────
    await incrementCareerUsage(req.user.id, 'cv_analysis');

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

    // ── Check daily job match limit ───────────────────────────────────────
    const jobLimitErr = await checkCareerLimit(
      req.user.id, req.user.plan, req.user.is_beta, req.user.is_admin, 'job_match'
    );
    if (jobLimitErr) return res.status(403).json(jobLimitErr);

    // ── Job match hash cache — skip AI if same CV+JD analyzed recently ────────
    const userMsg = messages.find(m => m.role === 'user');
    if (userMsg?.content) {
      const jobHash = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      const cached = await query(
        `SELECT job_match_cache FROM profiles
         WHERE user_id = $1
           AND job_match_hash = $2
           AND job_matched_at > NOW() - INTERVAL '24 hours'`,
        [req.user.id, jobHash]
      ).catch(() => ({ rows: [] }));

      if (cached.rows[0]?.job_match_cache) {
        console.log(`[career/job] ✅ Cache hit for user ${req.user.id}`);
        return res.json(cached.rows[0].job_match_cache);
      }
    }

    // Use Gemini Flash (free) — job matching is keyword comparison, not deep judgment
    let groqRes;
    try {
      groqRes = await callGemini({ messages, maxTokens: 2048, temperature: 0.2 });
      console.log('[career/job] Using Gemini Flash (free)');
    } catch {
      groqRes = await callGroq({ messages, model: 'llama-3.3-70b-versatile', maxTokens: 2048, temperature: 0.3 });
      console.log('[career/job] Fallback to Groq');
    }
    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });

    // ── Save job match to cache ───────────────────────────────────────────────
    if (userMsg?.content) {
      const jobHash = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      await query(
        `UPDATE profiles
         SET job_match_cache  = $1,
             job_match_hash   = $2,
             job_matched_at   = NOW()
         WHERE user_id = $3`,
        [JSON.stringify(groqRes.data), jobHash, req.user.id]
      ).catch(e => console.warn('[career/job] cache save failed:', e.message));
    }

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
    const coverMsgs = [
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
    ];
    // Use Gemini Flash (free) for cover letter — writing task, not analysis
    let groqRes;
    try {
      groqRes = await callGemini({ messages: coverMsgs, maxTokens: 1500, temperature: 0.7 });
      console.log('[career/cover] Using Gemini Flash (free)');
    } catch {
      groqRes = await callGroq({ messages: coverMsgs, model: 'llama-3.3-70b-versatile', maxTokens: 1500, temperature: 0.7 });
    }
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


// ─── POST /api/career/analyze-deep ───────────────────────────────────────────
// Call 2 — Deep intel: credibility, leadership, career story, interview risks
// Uses 70B model — runs in parallel with analyze-cv
router.post('/analyze-deep', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    const groqRes = await callGroq({ messages, model: 'llama-3.3-70b-versatile', maxTokens: 3000, temperature: 0.3 });
    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    const usage = groqRes.data?.usage;
    if (usage) console.log(`[career/deep] tokens: ${usage.total_tokens}`);
    res.json(groqRes.data);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-deep error:', err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data?.error?.message || err.message || 'Deep analysis failed' });
  }
});

// ─── POST /api/career/analyze-bullets ────────────────────────────────────────
// Call 3 — Bullet & vocabulary checks using fast 8B model
// Pattern matching only — no recruiter judgment needed
router.post('/analyze-bullets', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    // Use Gemini Flash (free) for pattern matching — no deep judgment needed
    let groqRes;
    try {
      groqRes = await callGemini({ messages, maxTokens: 2000, temperature: 0.1 });
      console.log('[career/bullets] Using Gemini Flash (free)');
    } catch {
      // Fallback to Groq 8B if Gemini unavailable
      groqRes = await callGroq({ messages, model: 'llama-3.1-8b-instant', maxTokens: 2000, temperature: 0.1 });
      console.log('[career/bullets] Fallback to Groq 8B');
    }
    const content = groqRes.data?.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    const usage = groqRes.data?.usage;
    if (usage) console.log(`[career/bullets] tokens: ${usage.total_tokens}`);
    res.json(groqRes.data);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-bullets error:', err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data?.error?.message || err.message || 'Bullet analysis failed' });
  }
});

module.exports = router;
