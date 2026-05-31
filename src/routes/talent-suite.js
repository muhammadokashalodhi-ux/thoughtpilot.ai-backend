'use strict';

/**
 * routes/talent-suite.js — Talent Suite Routes (Organisation accounts only)
 *
 * POST /api/talent/cv-screen        — upload candidate CV + JD → AI scores fit
 * POST /api/talent/job-description  — generate a polished job description
 * POST /api/talent/employer-brand   — generate employer branding post
 * POST /api/talent/outreach         — generate candidate outreach DM
 * GET  /api/talent/history          — list past results for this org
 */

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { query }       = require('../db/index');
const { requireAuth } = require('../middleware/auth');

// ── Feature flag + org guards (same as org.js) ────────────────────────────
function requireOrgMode(req, res, next) {
  if (process.env.ORG_MODE_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Talent Suite is not available yet' });
  }
  next();
}

function requireOrgAccount(req, res, next) {
  if (req.user.account_type !== 'organisation') {
    return res.status(403).json({ error: 'Talent Suite is for organisation accounts only' });
  }
  next();
}

// ── Get org for user ──────────────────────────────────────────────────────
async function getOrgForUser(userId) {
  const result = await query(
    `SELECT o.* FROM organisations o
     JOIN org_members m ON m.org_id = o.id
     WHERE m.user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ── Gemini Flash caller (free — writing + pattern tasks) ──────────────────
async function callGemini(prompt, maxTokens = 2000) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured');

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }], role: 'user' }],
      generationConfig: {
        temperature:      0.4,
        maxOutputTokens:  maxTokens,
        responseMimeType: 'application/json',
      },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

// ── Groq caller (deep analysis — CV screening) ────────────────────────────
async function callGroq(messages, maxTokens = 3000) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:           'llama-3.3-70b-versatile',
      max_tokens:      maxTokens,
      temperature:     0.2,
      messages,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.GROQ_CAREER_API_KEY || process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 90000,
    }
  );
  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return content;
}

// ── Save result to talent_suite_results ───────────────────────────────────
async function saveResult(orgId, userId, resultType, inputData, resultData) {
  try {
    await query(
      `INSERT INTO talent_suite_results (org_id, user_id, result_type, input_data, result_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, userId, resultType, JSON.stringify(inputData), JSON.stringify(resultData)]
    );
  } catch (err) {
    console.error('[talent] saveResult failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/talent/cv-screen
// Upload candidate CV text + job description → AI scores fit
// Completely isolated — no connection to any candidate account
// ═══════════════════════════════════════════════════════════════════════════
router.post('/cv-screen',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const { cv_text, job_description, candidate_name } = req.body;

    if (!cv_text || !job_description) {
      return res.status(400).json({ error: 'cv_text and job_description are required' });
    }
    if (cv_text.length < 100) {
      return res.status(400).json({ error: 'CV text is too short — paste the full CV' });
    }
    if (job_description.length < 50) {
      return res.status(400).json({ error: 'Job description is too short' });
    }

    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const prompt = `You are a senior recruiter at ${org.company_name || 'a company'} screening candidates.

Analyse this candidate CV against the job description below.
Be honest and specific. Quote exact CV text when citing evidence.

JOB DESCRIPTION:
${job_description.slice(0, 3000)}

CANDIDATE CV:
${cv_text.slice(0, 8000)}

Return ONLY valid JSON:
{
  "fit_score": <0-100>,
  "recommendation": "<hire|maybe|no>",
  "recommendation_reason": "<2 sentence honest summary>",
  "strengths": ["<strength with specific CV evidence>"],
  "gaps": ["<gap — what JD requires that CV lacks>"],
  "red_flags": ["<concern — vague claims, gaps, inconsistencies>"],
  "interview_questions": [
    {
      "question": "<specific question based on their CV>",
      "reason": "<what you are trying to verify>"
    }
  ],
  "culture_fit_signals": ["<signal from CV that fits or clashes with role>"],
  "overall_assessment": "<3-4 sentence honest recruiter assessment>"
}

SCORING RULES:
- 80-100: Strong hire — meets most requirements, clear evidence
- 60-79: Maybe — meets some requirements, has gaps but coachable
- 40-59: Risky — significant gaps or red flags
- Below 40: No hire — does not meet key requirements`;

      const raw    = await callGroq([{ role: 'user', content: prompt }]);
      const result = JSON.parse(raw);

      await saveResult(org.id, req.user.id, 'cv_screen',
        { candidate_name: candidate_name || 'Unknown', job_description: job_description.slice(0, 200) },
        result
      );

      console.log(`[talent] CV screen completed for org ${org.id} — score: ${result.fit_score}`);

      res.json({
        ...result,
        candidate_name: candidate_name || null,
        screened_at:    new Date().toISOString(),
      });
    } catch (err) {
      console.error('[talent] POST /cv-screen', err.message);
      res.status(500).json({ error: err.message || 'CV screening failed — please retry' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/talent/job-description
// Generate a polished job description from title + requirements
// ═══════════════════════════════════════════════════════════════════════════
router.post('/job-description',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const {
      job_title, department, requirements, nice_to_have,
      salary_range, location, remote_policy,
    } = req.body;

    if (!job_title) {
      return res.status(400).json({ error: 'job_title is required' });
    }

    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const prompt = `You are an expert HR writer creating a compelling job description.

Company: ${org.company_name || 'our company'}
Industry: ${org.industry || 'technology'}
Company description: ${org.products || org.services || 'industry leader'}

Job title: ${job_title}
Department: ${department || 'not specified'}
Location: ${location || 'not specified'}
Remote policy: ${remote_policy || 'not specified'}
Salary range: ${salary_range || 'competitive'}
Key requirements: ${requirements || 'not specified'}
Nice to have: ${nice_to_have || 'not specified'}

Write a compelling job description that attracts top talent.
Do NOT use corporate clichés like "fast-paced environment", "rockstar", "ninja", "guru".
Be specific, honest, and human.

Return ONLY valid JSON:
{
  "title": "<job title>",
  "tagline": "<one punchy sentence about the role — max 15 words>",
  "about_company": "<2-3 sentences about the company — honest, specific>",
  "about_role": "<3-4 sentences about what this person will actually do>",
  "responsibilities": ["<specific responsibility>"],
  "requirements": ["<must-have requirement>"],
  "nice_to_have": ["<good to have skill>"],
  "what_we_offer": ["<benefit or perk — be specific, not generic>"],
  "linkedin_post": "<a 150-word LinkedIn post to advertise this role>"
}`;

      const raw    = await callGemini(prompt, 2500);
      const result = JSON.parse(raw);

      await saveResult(org.id, req.user.id, 'job_description',
        { job_title, department },
        result
      );

      console.log(`[talent] JD generated for ${job_title} — org ${org.id}`);

      res.json(result);
    } catch (err) {
      console.error('[talent] POST /job-description', err.message);
      res.status(500).json({ error: err.message || 'Job description generation failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/talent/employer-brand
// Generate employer branding LinkedIn post
// ═══════════════════════════════════════════════════════════════════════════
router.post('/employer-brand',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const { topic, details, tone } = req.body;

    const VALID_TOPICS = [
      'company_culture', 'team_spotlight', 'growth_story',
      'values', 'office_life', 'hiring', 'milestone', 'csr',
    ];

    if (!topic || !VALID_TOPICS.includes(topic)) {
      return res.status(400).json({
        error: 'topic is required',
        valid_topics: VALID_TOPICS,
      });
    }

    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const topicLabels = {
        company_culture: 'company culture and values',
        team_spotlight:  'a team member or team achievement',
        growth_story:    'company growth and milestones',
        values:          'company values in action',
        office_life:     'day in the life at the company',
        hiring:          'why people should join the company',
        milestone:       'a company milestone or achievement',
        csr:             'corporate social responsibility initiative',
      };

      const brandVoiceDesc = {
        professional:  'authoritative but approachable, credible, data-driven',
        friendly:      'warm, human, conversational, uses we and our team',
        authoritative: 'confident, expert, industry leader tone',
        innovative:    'forward-thinking, disruptive, excited about change',
      };

      const prompt = `You are a LinkedIn content strategist writing an employer branding post.

Company: ${org.company_name}
Industry: ${org.industry || 'not specified'}
Brand voice: ${brandVoiceDesc[org.brand_voice || 'professional']}
Target audience: ${org.target_audience || 'potential employees and industry peers'}
Topic: ${topicLabels[topic]}
Additional details: ${details || 'none provided'}
Tone preference: ${tone || org.brand_voice || 'professional'}

Write 3 LinkedIn post variants for this company's employer brand.
Each post should feel authentic — not like a press release.
Use "we" and "our team". Never use "I".
Include relevant emojis naturally. End each post with 3-5 relevant hashtags.

Return ONLY valid JSON:
{
  "posts": [
    {
      "variant": "A",
      "angle": "<one word angle — e.g. storytelling|data|emotion>",
      "content": "<full post text with hashtags at the end>",
      "word_count": <number>
    },
    {
      "variant": "B",
      "angle": "<angle>",
      "content": "<full post text>",
      "word_count": <number>
    },
    {
      "variant": "C",
      "angle": "<angle>",
      "content": "<full post text>",
      "word_count": <number>
    }
  ]
}`;

      const raw    = await callGemini(prompt, 2000);
      const result = JSON.parse(raw);

      await saveResult(org.id, req.user.id, 'employer_brand',
        { topic, details },
        result
      );

      console.log(`[talent] Employer brand post generated — topic: ${topic} — org ${org.id}`);

      res.json(result);
    } catch (err) {
      console.error('[talent] POST /employer-brand', err.message);
      res.status(500).json({ error: err.message || 'Employer branding post generation failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/talent/outreach
// Generate personalised candidate outreach LinkedIn DM
// ═══════════════════════════════════════════════════════════════════════════
router.post('/outreach',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const {
      candidate_name, candidate_role, target_role,
      hook, tone,
    } = req.body;

    if (!candidate_name || !target_role) {
      return res.status(400).json({ error: 'candidate_name and target_role are required' });
    }

    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const prompt = `You are a recruiter at ${org.company_name || 'a company'} writing a LinkedIn DM.

Write 3 variations of a personalised candidate outreach message.

Candidate name: ${candidate_name}
Candidate current role: ${candidate_role || 'not specified'}
Role you are recruiting for: ${target_role}
Personal hook (what you noticed about them): ${hook || 'their background and experience'}
Company: ${org.company_name}
Industry: ${org.industry || 'not specified'}
Tone: ${tone || 'professional and warm'}

Rules:
- Under 150 words each
- Sound like a real person wrote it, not a template
- Mention their name naturally
- Reference the hook specifically
- One clear call to action
- Do NOT use "I hope this message finds you well"
- Do NOT be overly formal

Return ONLY valid JSON:
{
  "messages": [
    {
      "variant": "A",
      "style": "<direct|curious|warm>",
      "content": "<full DM text>",
      "word_count": <number>
    },
    {
      "variant": "B",
      "style": "<style>",
      "content": "<full DM text>",
      "word_count": <number>
    },
    {
      "variant": "C",
      "style": "<style>",
      "content": "<full DM text>",
      "word_count": <number>
    }
  ]
}`;

      const raw    = await callGemini(prompt, 1500);
      const result = JSON.parse(raw);

      await saveResult(org.id, req.user.id, 'outreach',
        { candidate_name, target_role },
        result
      );

      console.log(`[talent] Outreach DM generated for ${candidate_name} — org ${org.id}`);

      res.json(result);
    } catch (err) {
      console.error('[talent] POST /outreach', err.message);
      res.status(500).json({ error: err.message || 'Outreach message generation failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/talent/history
// List past Talent Suite results for this org
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const { type, limit = 20, offset = 0 } = req.query;

    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const conditions = ['t.org_id = $1'];
      const params = [org.id];

      if (type) {
        params.push(type);
        conditions.push(`t.result_type = $${params.length}`);
      }

      params.push(parseInt(limit, 10));
      params.push(parseInt(offset, 10));

      const results = await query(
        `SELECT
           t.id, t.result_type, t.input_data, t.created_at,
           u.full_name as created_by
         FROM talent_suite_results t
         JOIN users u ON u.id = t.user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({
        results:  results.rows,
        total:    results.rows.length,
        limit:    parseInt(limit, 10),
        offset:   parseInt(offset, 10),
      });
    } catch (err) {
      console.error('[talent] GET /history', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
