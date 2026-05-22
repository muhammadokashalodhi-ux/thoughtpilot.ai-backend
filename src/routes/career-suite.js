// career-suite.js — ThoughtPilot Career Suite backend routes
// Add to your Express app: app.use('/api/career', require('./career-suite'))

const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────
// Auth middleware (reuse your existing verifyToken)
// ─────────────────────────────────────────────
const verifyToken = require('../middleware/verifyToken'); // adjust path as needed

// ─────────────────────────────────────────────
// GET /api/career/handoff
// Returns user profile + cv_prefill text built from profile
// ─────────────────────────────────────────────
router.get('/handoff', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // Adjust to your DB model — example uses a generic query helper
    const { db } = require('../db'); // adjust path

    const user = await db.query(
      'SELECT id, email, full_name, plan FROM users WHERE id = $1',
      [userId]
    );

    if (!user.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const profile = await db.query(
      'SELECT * FROM career_profiles WHERE user_id = $1',
      [userId]
    );

    const u = user.rows[0];
    const p = profile.rows[0] || {};

    // Build cv_prefill from profile data
    const cv_prefill = buildCVFromProfile(u, p);

    return res.json({
      user: {
        id: u.id,
        email: u.email,
        full_name: u.full_name,
        plan: u.plan || 'free',
      },
      profile: {
        role: p.role || '',
        headline: p.headline || '',
        location: p.location || '',
        years_experience: p.years_experience || 0,
        sectors: p.sectors || [],
        companies: p.companies || [],
        countries: p.countries || [],
        achievements: p.achievements || [],
        credentials: p.credentials || [],
      },
      cv_prefill,
    });
  } catch (err) {
    console.error('[career/handoff]', err);
    return res.status(500).json({ error: 'Failed to fetch handoff data' });
  }
});

// ─────────────────────────────────────────────
// POST /api/career/save-cv
// Saves improved CV text back to user's profile
// ─────────────────────────────────────────────
router.post('/save-cv', verifyToken, async (req, res) => {
  try {
    const { cv_text } = req.body;
    const userId = req.user.id;

    if (!cv_text || typeof cv_text !== 'string') {
      return res.status(400).json({ error: 'cv_text is required' });
    }

    const { db } = require('../db');

    await db.query(
      `INSERT INTO career_profiles (user_id, cv_text, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET cv_text = $2, updated_at = NOW()`,
      [userId, cv_text]
    );

    return res.json({ success: true, message: 'CV saved to profile' });
  } catch (err) {
    console.error('[career/save-cv]', err);
    return res.status(500).json({ error: 'Failed to save CV' });
  }
});

// ─────────────────────────────────────────────
// GET /api/career/status
// Returns feature gates based on user plan
// ─────────────────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const { db } = require('../db');
    const user = await db.query(
      'SELECT plan FROM users WHERE id = $1',
      [req.user.id]
    );

    const plan = user.rows[0]?.plan || 'free';

    const gates = {
      plan,
      can_use_job_match: ['beta', 'pro', 'executive'].includes(plan),
      can_use_modern_template: ['beta', 'pro', 'executive'].includes(plan),
      can_use_minimal_template: ['beta', 'pro', 'executive'].includes(plan),
      can_use_executive_template: ['pro', 'executive'].includes(plan),
      can_use_compact_template: ['pro', 'executive'].includes(plan),
      can_save_to_profile: plan !== 'free',
      max_analyses_per_day: plan === 'free' ? 3 : plan === 'beta' ? 20 : 100,
    };

    return res.json(gates);
  } catch (err) {
    console.error('[career/status]', err);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─────────────────────────────────────────────
// POST /api/career/cover-letter  ← NEW ROUTE
// Generates a cover letter using Groq
// Body: { job_description, cv_text, user_name, user_role }
// Returns: { cover_letter: "full cover letter text" }
// ─────────────────────────────────────────────
router.post('/cover-letter', verifyToken, async (req, res) => {
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

    const userMessage = `Write a cover letter for ${user_name || 'the applicant'} (${user_role || 'professional'}).

CV:
${cv_text}

JOB DESCRIPTION:
${job_description}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      temperature: 0.5,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const cover_letter = completion.choices[0]?.message?.content?.trim() || '';

    if (!cover_letter) {
      return res.status(500).json({ error: 'Failed to generate cover letter' });
    }

    return res.json({ cover_letter });
  } catch (err) {
    console.error('[career/cover-letter]', err);
    return res.status(500).json({ error: 'Cover letter generation failed' });
  }
});

// ─────────────────────────────────────────────
// Helper: build CV text from ThoughtPilot profile
// ─────────────────────────────────────────────
function buildCVFromProfile(user, profile) {
  const lines = [];

  lines.push(user.full_name || 'Your Name');
  if (profile.role) lines.push(profile.role);
  if (profile.location) lines.push(profile.location);
  if (user.email) lines.push(user.email);
  lines.push('');

  if (profile.headline) {
    lines.push('PROFESSIONAL SUMMARY');
    lines.push(profile.headline);
    lines.push('');
  }

  if (profile.achievements?.length > 0) {
    lines.push('KEY ACHIEVEMENTS');
    profile.achievements.forEach((a) => lines.push(`• ${a}`));
    lines.push('');
  }

  if (profile.companies?.length > 0) {
    lines.push('EXPERIENCE');
    profile.companies.forEach((c, i) => {
      lines.push(`${profile.role || 'Professional'} — ${c}`);
      if (profile.sectors?.[i]) lines.push(`Sector: ${profile.sectors[i]}`);
    });
    lines.push('');
  }

  if (profile.credentials?.length > 0) {
    lines.push('EDUCATION & CREDENTIALS');
    profile.credentials.forEach((c) => lines.push(`• ${c}`));
    lines.push('');
  }

  if (profile.countries?.length > 0) {
    lines.push('INTERNATIONAL EXPERIENCE');
    lines.push(profile.countries.join(', '));
  }

  return lines.join('\n');
}

module.exports = router;
