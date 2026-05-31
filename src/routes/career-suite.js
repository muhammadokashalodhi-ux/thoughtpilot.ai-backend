'use strict';

const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const crypto       = require('crypto');
const { query }    = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getLimitsForPlan } = require('../config/limits');

// ─── Career limit checker ─────────────────────────────────────────────────────
// Returns error object if limit hit, null if allowed
// Also increments the counter atomically — no separate increment needed
async function checkAndIncrementLimit(userId, plan, isBeta, isAdmin, limitType) {
  if (isBeta || isAdmin) return null; // beta/admin = unlimited

  const limits = getLimitsForPlan(plan);

  if (limitType === 'cv_analysis') {
    const limit = limits.cv_analyses_per_day || 1;

    // Ensure row exists first
    await query(
      'INSERT INTO usage_tracking (user_id, cv_analyses_today, cv_day_reset_at) VALUES ($1, 0, CURRENT_DATE) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );

    // Reset counter if it is a new day
    await query(
      'UPDATE usage_tracking SET cv_analyses_today = 0, cv_day_reset_at = CURRENT_DATE WHERE user_id = $1 AND cv_day_reset_at < CURRENT_DATE',
      [userId]
    );

    // Read current count
    const r = await query(
      'SELECT cv_analyses_today FROM usage_tracking WHERE user_id = $1',
      [userId]
    );
    const used = r.rows[0] ? r.rows[0].cv_analyses_today : 0;

    console.log('[career] CV limit check — user: ' + userId + ', plan: ' + plan + ', used: ' + used + ', limit: ' + limit);

    if (used >= limit) {
      return {
        error: 'Daily CV analysis limit reached — upgrade to analyse more CVs',
        code: 'USAGE_LIMIT',
        limit_key: 'cv_analyses_per_day',
        used: used,
        limit: limit,
        plan: plan,
        upgrade_url: (process.env.FRONTEND_URL || 'https://app.thoughtpilotai.com') + '/dashboard/billing',
      };
    }

    // Increment
    await query(
      'UPDATE usage_tracking SET cv_analyses_today = cv_analyses_today + 1 WHERE user_id = $1',
      [userId]
    );
    console.log('[career] CV analysis incremented for user ' + userId + ' — now ' + (used + 1) + '/' + limit);
    return null;
  }

  if (limitType === 'job_match') {
    const limit = limits.job_matches_per_day || 2;

    await query(
      'INSERT INTO usage_tracking (user_id, job_matches_today, job_day_reset_at) VALUES ($1, 0, CURRENT_DATE) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );

    await query(
      'UPDATE usage_tracking SET job_matches_today = 0, job_day_reset_at = CURRENT_DATE WHERE user_id = $1 AND job_day_reset_at < CURRENT_DATE',
      [userId]
    );

    const r = await query(
      'SELECT job_matches_today FROM usage_tracking WHERE user_id = $1',
      [userId]
    );
    const used = r.rows[0] ? r.rows[0].job_matches_today : 0;

    console.log('[career] Job limit check — user: ' + userId + ', plan: ' + plan + ', used: ' + used + ', limit: ' + limit);

    if (used >= limit) {
      return {
        error: 'Daily job match limit reached — upgrade to run more matches',
        code: 'USAGE_LIMIT',
        limit_key: 'job_matches_per_day',
        used: used,
        limit: limit,
        plan: plan,
        upgrade_url: (process.env.FRONTEND_URL || 'https://app.thoughtpilotai.com') + '/dashboard/billing',
      };
    }

    await query(
      'UPDATE usage_tracking SET job_matches_today = job_matches_today + 1 WHERE user_id = $1',
      [userId]
    );
    console.log('[career] Job match incremented for user ' + userId + ' — now ' + (used + 1) + '/' + limit);
    return null;
  }

  return null;
}

// ─── Groq caller with model fallback ─────────────────────────────────────────
const MODEL_CHAIN = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

async function callGroq({ messages, model, maxTokens, temperature }) {
  model       = model       || 'llama-3.3-70b-versatile';
  maxTokens   = maxTokens   || 3000;
  temperature = temperature || 0.3;

  const startIdx = MODEL_CHAIN.indexOf(model);
  const chain    = startIdx >= 0 ? MODEL_CHAIN.slice(startIdx) : [model].concat(MODEL_CHAIN);

  for (var ci = 0; ci < chain.length; ci++) {
    var currentModel = chain[ci];
    var effectiveMessages = messages;
    var effectiveMaxTokens = maxTokens;

    // 8B has low TPM — trim large messages
    if (currentModel === 'llama-3.1-8b-instant') {
      effectiveMessages = messages.map(function(m) {
        if (m.role === 'user' && m.content && m.content.length > 8000) {
          return { role: m.role, content: m.content.slice(0, 8000) };
        }
        return m;
      });
      effectiveMaxTokens = Math.min(maxTokens, 1500);
    }

    var lastErr = null;
    for (var attempt = 1; attempt <= 2; attempt++) {
      try {
        var res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: currentModel,
            max_tokens: effectiveMaxTokens,
            temperature: temperature,
            messages: effectiveMessages,
            response_format: { type: 'json_object' },
          },
          {
            headers: {
              Authorization: 'Bearer ' + (process.env.GROQ_CAREER_API_KEY || process.env.GROQ_API_KEY),
              'Content-Type': 'application/json',
            },
            timeout: 90000,
          }
        );
        if (currentModel !== model) {
          console.log('[career/groq] Using fallback model: ' + currentModel);
        }
        return res;
      } catch (err) {
        lastErr = err;
        var status  = err && err.response ? err.response.status : 0;
        var errMsg  = err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message || '' : '';
        var errCode = err && err.response && err.response.data && err.response.data.error ? err.response.data.error.code || '' : '';

        // Model decommissioned — try next
        if (status === 500 && (errMsg.indexOf('decommissioned') !== -1 || errMsg.indexOf('does not exist') !== -1)) {
          console.warn('[career/groq] Model ' + currentModel + ' unavailable — trying next');
          break;
        }
        // Daily token limit — try next model
        if (status === 429 && errMsg.indexOf('tokens per day') !== -1) {
          console.warn('[career/groq] Daily limit hit for ' + currentModel + ' — trying next model');
          break;
        }
        // Per-minute rate limit — wait and retry
        if (status === 429 && attempt < 2) {
          console.warn('[career/groq] 429 TPM — waiting 10s (attempt ' + attempt + '/2)');
          await new Promise(function(r) { setTimeout(r, 10000); });
          continue;
        }
        // Other error — throw immediately
        throw err;
      }
    }
  }

  // All models exhausted
  throw {
    response: {
      status: 429,
      data: { error: { message: 'All models at daily limit. Resets at midnight UTC.', code: 'daily_limit_exhausted' } },
    },
  };
}

// ─── Gemini Flash caller (free) ───────────────────────────────────────────────
async function callGemini({ messages, maxTokens, temperature }) {
  maxTokens   = maxTokens   || 2000;
  temperature = temperature || 0.1;

  var GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    console.error('[career/gemini] GEMINI_API_KEY not set');
    throw new Error('Gemini not configured');
  }

  var systemMsg = '';
  var userMsg   = '';
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') systemMsg = messages[i].content || '';
    if (messages[i].role === 'user')   userMsg   = messages[i].content || '';
  }

  var res = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY,
    {
      contents: [{ parts: [{ text: systemMsg + '\n\n' + userMsg }], role: 'user' }],
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 25000,
    }
  );

  var text = res.data && res.data.candidates && res.data.candidates[0] &&
             res.data.candidates[0].content && res.data.candidates[0].content.parts &&
             res.data.candidates[0].content.parts[0] ? res.data.candidates[0].content.parts[0].text : null;

  if (!text) {
    console.error('[career/gemini] Empty response');
    throw new Error('Empty response from Gemini');
  }

  return {
    data: {
      choices: [{ message: { content: text } }],
      usage: { total_tokens: res.data.usageMetadata ? res.data.usageMetadata.totalTokenCount || 0 : 0 },
    },
  };
}

// ─── GET /api/career/handoff ──────────────────────────────────────────────────
router.get('/handoff', requireAuth, async (req, res) => {
  try {
    var result = await query(
      'SELECT u.id, u.email, u.full_name, u.plan, u.is_beta, u.is_admin, u.onboarding_complete, p.user_role, p.sectors, p.location, p.voice_tone, p.years_experience, p.user_headline, p.companies, p.achievements, p.credentials, p.about_summary AS cv_prefill, p.cv_analysis_cache, p.cv_analysis_hash, p.cv_analyzed_at FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    var row = result.rows[0];
    res.json({
      user: {
        id: row.id, email: row.email, full_name: row.full_name,
        plan: row.plan, is_beta: row.is_beta, is_admin: row.is_admin,
        onboarding_complete: row.onboarding_complete,
      },
      profile: {
        user_role: row.user_role, sectors: row.sectors, location: row.location,
        voice_tone: row.voice_tone, years_experience: row.years_experience,
        user_headline: row.user_headline, companies: row.companies,
        achievements: row.achievements, credentials: row.credentials,
      },
      cv_prefill:        row.cv_prefill        || null,
      cv_analysis_cache: row.cv_analysis_cache || null,
      cv_analyzed_at:    row.cv_analyzed_at    || null,
    });
  } catch (err) {
    console.error('[career] handoff error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/career/analyze-cv ─────────────────────────────────────────────
router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    var messages = req.body.messages;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    console.log('[career] analyze-cv — user ' + req.user.id);

    // Check + increment limit
    var limitErr = await checkAndIncrementLimit(
      req.user.id, req.user.plan, req.user.is_beta, req.user.is_admin, 'cv_analysis'
    );
    if (limitErr) return res.status(403).json(limitErr);

    // CV hash cache
    var userMsg = null;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') { userMsg = messages[i]; break; }
    }
    if (userMsg && userMsg.content) {
      var cvHash = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      var cached = await query(
        'SELECT cv_analysis_cache FROM profiles WHERE user_id = $1 AND cv_analysis_hash = $2 AND cv_analyzed_at > NOW() - INTERVAL \'7 days\'',
        [req.user.id, cvHash]
      ).catch(function() { return { rows: [] }; });
      if (cached.rows[0] && cached.rows[0].cv_analysis_cache) {
        console.log('[career] Cache hit for user ' + req.user.id);
        return res.json(cached.rows[0].cv_analysis_cache);
      }
    }

    // Call Groq
    var groqRes = await callGroq({ messages: messages, model: 'llama-3.3-70b-versatile', maxTokens: 4096, temperature: 0.3 });
    var content = groqRes.data && groqRes.data.choices && groqRes.data.choices[0] ? groqRes.data.choices[0].message.content : null;
    if (!content || !content.trim()) {
      return res.status(500).json({ error: 'Empty response from AI — please retry' });
    }

    var usage = groqRes.data.usage;
    if (usage) console.log('[career] tokens — total: ' + usage.total_tokens);

    // Save to cache
    if (userMsg && userMsg.content) {
      var cvHash2 = crypto.createHash('sha256').update(userMsg.content).digest('hex');
      await query(
        'UPDATE profiles SET cv_analysis_cache = $1, cv_analysis_hash = $2, cv_analyzed_at = NOW() WHERE user_id = $3',
        [JSON.stringify(groqRes.data), cvHash2, req.user.id]
      ).catch(function(e) { console.warn('[career] cache save failed:', e.message); });
    }

    res.json(groqRes.data);
  } catch (err) {
    var status  = err && err.response ? err.response.status : 0;
    var errData = err && err.response ? err.response.data : null;
    console.error('[career] analyze-cv error — status: ' + status, errData || err.message);
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please wait 30 seconds and retry' });
    if (status === 413) return res.status(413).json({ error: 'CV is too long for analysis — please shorten it and retry' });
    res.status(500).json({ error: (errData && errData.error ? errData.error.message : null) || err.message || 'Analysis failed — please retry' });
  }
});

// ─── POST /api/career/analyze-deep ───────────────────────────────────────────
router.post('/analyze-deep', requireAuth, async (req, res) => {
  try {
    var messages = req.body.messages;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    var groqRes = await callGroq({ messages: messages, model: 'llama-3.3-70b-versatile', maxTokens: 3000, temperature: 0.3 });
    var content = groqRes.data && groqRes.data.choices && groqRes.data.choices[0] ? groqRes.data.choices[0].message.content : null;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    var usage = groqRes.data.usage;
    if (usage) console.log('[career/deep] tokens: ' + usage.total_tokens);
    res.json(groqRes.data);
  } catch (err) {
    var status = err && err.response ? err.response.status : 0;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-deep error:', err && err.response ? err.response.data : err.message);
    res.status(500).json({ error: err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message || 'Deep analysis failed' });
  }
});

// ─── POST /api/career/analyze-bullets ────────────────────────────────────────
router.post('/analyze-bullets', requireAuth, async (req, res) => {
  try {
    var messages = req.body.messages;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    var groqRes;
    try {
      groqRes = await callGemini({ messages: messages, maxTokens: 2000, temperature: 0.1 });
      console.log('[career/bullets] Using Gemini Flash (free)');
    } catch (geminiErr) {
      console.error('[career/gemini] Bullet check failed:', geminiErr.message);
      groqRes = await callGroq({ messages: messages, model: 'llama-3.1-8b-instant', maxTokens: 2000, temperature: 0.1 });
      console.log('[career/bullets] Fallback to Groq 8B');
    }
    var content = groqRes.data && groqRes.data.choices && groqRes.data.choices[0] ? groqRes.data.choices[0].message.content : null;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    var usage = groqRes.data.usage;
    if (usage) console.log('[career/bullets] tokens: ' + usage.total_tokens);
    res.json(groqRes.data);
  } catch (err) {
    var status = err && err.response ? err.response.status : 0;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-bullets error:', err && err.response ? err.response.data : err.message);
    res.status(500).json({ error: err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message || 'Bullet analysis failed' });
  }
});

// ─── POST /api/career/analyze-job ────────────────────────────────────────────
router.post('/analyze-job', requireAuth, async (req, res) => {
  try {
    var messages = req.body.messages;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Check + increment limit
    var limitErr = await checkAndIncrementLimit(
      req.user.id, req.user.plan, req.user.is_beta, req.user.is_admin, 'job_match'
    );
    if (limitErr) return res.status(403).json(limitErr);

    var groqRes;
    try {
      groqRes = await callGemini({ messages: messages, maxTokens: 2048, temperature: 0.2 });
      console.log('[career/job] Using Gemini Flash (free)');
    } catch (geminiErr) {
      console.error('[career/gemini] Job match failed:', geminiErr.message);
      groqRes = await callGroq({ messages: messages, model: 'llama-3.3-70b-versatile', maxTokens: 2048, temperature: 0.3 });
      console.log('[career/job] Fallback to Groq');
    }
    var content = groqRes.data && groqRes.data.choices && groqRes.data.choices[0] ? groqRes.data.choices[0].message.content : null;
    if (!content) return res.status(500).json({ error: 'Empty response from AI — please retry' });
    res.json(groqRes.data);
  } catch (err) {
    var status = err && err.response ? err.response.status : 0;
    if (status === 429) return res.status(429).json({ error: 'Rate limit reached — please retry in 30 seconds' });
    console.error('[career] analyze-job error:', err && err.response ? err.response.data : err.message);
    res.status(500).json({ error: err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message || 'Job match failed' });
  }
});

// ─── POST /api/career/cover-letter ───────────────────────────────────────────
router.post('/cover-letter', requireAuth, async (req, res) => {
  try {
    var cv_text              = req.body.cv_text;
    var job_description      = req.body.job_description;
    var user_name            = req.body.user_name;
    var user_role            = req.body.user_role;
    var approved_suggestions = req.body.approved_suggestions;

    if (!cv_text || !job_description) {
      return res.status(400).json({ error: 'cv_text and job_description are required' });
    }

    var suggestionsText = '';
    if (approved_suggestions && approved_suggestions.length) {
      suggestionsText = 'APPROVED IMPROVEMENTS TO INCORPORATE:\n' + approved_suggestions.slice(0, 5).join('\n');
    }

    var coverMsgs = [
      {
        role: 'system',
        content: 'You are an expert cover letter writer. Write a professional, personalized cover letter. Format: 3-4 paragraphs. Tone: confident but not arrogant. Length: 300-400 words. Do NOT use generic phrases like "I am writing to apply". Open with a strong hook. Return ONLY the cover letter text.',
      },
      {
        role: 'user',
        content: 'Write a cover letter for ' + (user_name || 'the candidate') + ' (' + (user_role || 'professional') + ').\n\nCV SUMMARY:\n' + cv_text.slice(0, 3000) + '\n\nJOB DESCRIPTION:\n' + job_description.slice(0, 2000) + (suggestionsText ? '\n\n' + suggestionsText : ''),
      },
    ];

    var groqRes;
    try {
      groqRes = await callGemini({ messages: coverMsgs, maxTokens: 1500, temperature: 0.7 });
      console.log('[career/cover] Using Gemini Flash (free)');
    } catch (geminiErr) {
      groqRes = await callGroq({ messages: coverMsgs, model: 'llama-3.3-70b-versatile', maxTokens: 1500, temperature: 0.7 });
    }
    var cover_letter = groqRes.data && groqRes.data.choices && groqRes.data.choices[0] ? groqRes.data.choices[0].message.content || '' : '';
    if (!cover_letter) return res.status(500).json({ error: 'Failed to generate cover letter' });
    res.json({ cover_letter: cover_letter });
  } catch (err) {
    console.error('[career] cover-letter error:', err && err.response ? err.response.data : err.message);
    res.status(500).json({ error: err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message || 'Cover letter generation failed' });
  }
});

// ─── POST /api/career/save-cv ─────────────────────────────────────────────────
router.post('/save-cv', requireAuth, async (req, res) => {
  try {
    var cv_text = req.body.cv_text;
    if (!cv_text) return res.status(400).json({ error: 'cv_text is required' });
    await query('UPDATE profiles SET about_summary = $1 WHERE user_id = $2', [cv_text, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[career] save-cv error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/career/status ───────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    var result = await query('SELECT u.plan, u.is_beta, u.is_admin FROM users u WHERE u.id = $1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    var plan     = result.rows[0].plan;
    var is_beta  = result.rows[0].is_beta;
    var is_admin = result.rows[0].is_admin;
    res.json({
      enabled: true, plan: plan, is_beta: is_beta, is_admin: is_admin,
      features: {
        full_analysis:  is_beta || is_admin || plan === 'pro',
        job_match:      is_beta || is_admin || plan === 'pro' || plan === 'starter',
        cover_letter:   is_beta || is_admin || plan === 'pro',
        export_word:    is_beta || is_admin || plan === 'pro',
        export_pdf:     true,
        templates_all:  is_beta || is_admin || plan === 'pro',
      },
    });
  } catch (err) {
    console.error('[career] status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
