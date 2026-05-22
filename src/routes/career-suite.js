'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// src/routes/career-suite.js
//
// This file handles the ThoughtPilot → Career Suite app connection.
// When the Career Suite app is built, it will call GET /api/career/handoff
// to verify the user and get their profile context without requiring
// them to sign in again.
// ─────────────────────────────────────────────────────────────────────────────

const express         = require('express');
const router          = express.Router();
const { query }       = require('../db');
const { requireAuth } = require('../middleware/auth');
const Groq            = require('groq-sdk');
const groq            = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── GET /api/career/handoff ──────────────────────────────────────────────────
// Called by the Career Suite app to get user context from ThoughtPilot token.
// The Career Suite app passes the tp_token cookie in the request.
// Returns: user profile context for pre-filling the Career Suite.
router.get('/handoff', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        u.id, u.email, u.full_name, u.plan, u.is_beta,
        p.user_role, p.sectors, p.location, p.years_experience,
        p.about_summary, p.achievements, p.credentials, p.user_headline,
        p.companies, p.countries
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Build a pre-filled CV text from profile if about_summary exists
    const cvContext = user.about_summary || buildCVFromProfile(user);

    res.json({
      user: {
        id:          user.id,
        email:       user.email,
        full_name:   user.full_name,
        plan:        user.is_beta ? 'beta' : user.plan,
      },
      profile: {
        role:             user.user_role,
        headline:         user.user_headline,
        location:         user.location,
        years_experience: user.years_experience,
        sectors:          user.sectors,
        companies:        user.companies,
        countries:        user.countries,
        achievements:     user.achievements,
        credentials:      user.credentials,
      },
      cv_prefill: cvContext,
    });
  } catch (err) {
    console.error('[career/handoff]', err.message);
    res.status(500).json({ error: 'Handoff failed' });
  }
});

// POST /api/career/analyze-cv
router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    if (!req.body.messages) return res.status(400).json({ error: 'messages required' });

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        temperature: 0.3,
        messages: req.body.messages,
      }),
    });

    const data = await groqRes.json();
    res.json(data);
  } catch (err) {
    console.error('[career/analyze-cv]', err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// POST /api/career/analyze-job
router.post('/analyze-job', requireAuth, async (req, res) => {
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        temperature: 0.3,
        messages: req.body.messages,
      }),
    });

    const data = await groqRes.json();
    res.json(data);
  } catch (err) {
    console.error('[career/analyze-job]', err.message);
    res.status(500).json({ error: 'Job match failed' });
  }
});


// ─── POST /api/career/save-cv ─────────────────────────────────────────────────
// Career Suite app saves improved CV back to ThoughtPilot profile.
router.post('/save-cv', requireAuth, async (req, res) => {
  try {
    const { cv_text } = req.body;
    if (!cv_text || cv_text.trim().length < 50) {
      return res.status(400).json({ error: 'CV text is required' });
    }
    await query(
      `UPDATE profiles SET about_summary = $1, updated_at = NOW() WHERE user_id = $2`,
      [cv_text.substring(0, 10000), req.user.id]
    );
    res.json({ message: 'CV saved to ThoughtPilot profile' });
  } catch (err) {
    console.error('[career/save-cv]', err.message);
    res.status(500).json({ error: 'Failed to save CV' });
  }
});

// ─── GET /api/career/status ───────────────────────────────────────────────────
// Returns whether the Career Suite app is live and what plan features are enabled.
router.get('/status', requireAuth, async (req, res) => {
  const plan = req.user.is_beta ? 'beta' : req.user.plan;

  res.json({
    app_url:     process.env.CAREER_SUITE_URL || 'https://careers.thoughtpilotai.com',
    is_live:     process.env.CAREER_SUITE_LIVE === 'true',
    user_plan:   plan,
    // Feature gates — update these when Stripe is live in Phase 5
    features: {
      ats_analysis:  true,              // free
      job_match:     true,              // free
      ai_editor:     ['beta','starter','pro'].includes(plan),
      template_modern:  ['beta','starter','pro'].includes(plan),
      template_minimal: ['beta','pro'].includes(plan),
      template_executive: plan === 'pro',
      template_compact:   plan === 'pro',
      pdf_export:    true,              // free (classic template)
      docx_export:   ['beta','starter','pro'].includes(plan),
      version_history: ['beta','pro'].includes(plan),
    },
  });
});

// POST /api/career/cover-letter
router.post('/cover-letter', requireAuth, async (req, res) => {
  try {
    const { job_description, cv_text, user_name, user_role } = req.body;

    if (!job_description || !cv_text) {
      return res.status(400).json({ error: 'job_description and cv_text are required' });
    }

    const systemPrompt = `You are an expert career coach and professional writer.
Write a compelling, personalised cover letter. Be specific, confident, and concise.
Use a professional but human tone. 3 paragraphs max. Do NOT use generic phrases like "I am writing to apply".
Reference specific details from the job description and match them to the candidate's experience.
Return ONLY the cover letter text — no subject line, no metadata, no preamble.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      temperature: 0.5,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Write a cover letter for ${user_name || 'the applicant'} (${user_role || 'professional'}).\n\nCV:\n${cv_text}\n\nJOB DESCRIPTION:\n${job_description}` },
      ],
    });

    const cover_letter = completion.choices[0]?.message?.content?.trim() || '';
    if (!cover_letter) return res.status(500).json({ error: 'Failed to generate cover letter' });

    return res.json({ cover_letter });
  } catch (err) {
    console.error('[career/cover-letter]', err);
    return res.status(500).json({ error: 'Cover letter generation failed' });
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function buildCVFromProfile(p) {
  const parts = [];
  if (p.full_name)        parts.push(`NAME: ${p.full_name}`);
  if (p.user_role)        parts.push(`ROLE: ${p.user_role}`);
  if (p.user_headline)    parts.push(`HEADLINE: ${p.user_headline}`);
  if (p.location)         parts.push(`LOCATION: ${p.location}`);
  if (p.years_experience) parts.push(`YEARS EXPERIENCE: ${p.years_experience}`);
  if (p.achievements)     parts.push(`\nACHIEVEMENTS:\n${p.achievements}`);
  if (p.credentials)      parts.push(`\nCREDENTIALS:\n${p.credentials}`);
  if (p.companies)        parts.push(`\nCOMPANIES: ${p.companies}`);
  if (p.countries)        parts.push(`\nCOUNTRIES: ${p.countries}`);
  const sectors = Array.isArray(p.sectors) ? p.sectors.join(', ') : '';
  if (sectors)            parts.push(`\nSECTORS: ${sectors}`);
  return parts.join('\n');
}

module.exports = router;
