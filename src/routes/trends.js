const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');

const CACHE_TTL_HOURS = 6;

// ─── GET /api/trends ─────────────────────────────────────────────────────────
// Returns SCM trends aligned to the user's sectors
// Caches per-sectors-hash for CACHE_TTL_HOURS hours in trends_cache table
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { refresh } = req.query;

    // Load user sectors from profile
    const profileResult = await query(
      `SELECT sectors FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found. Please complete onboarding.' });
    }

    const sectors = profileResult.rows[0].sectors || [];
    const sectorsKey = JSON.stringify([...sectors].sort()); // stable key

    // Check cache unless forced refresh
    if (refresh !== 'true') {
      const cached = await query(
        `SELECT trends_data, fetched_at, expires_at FROM trends_cache
         WHERE sectors::text = $1 AND expires_at > NOW()
         ORDER BY fetched_at DESC LIMIT 1`,
        [sectorsKey]
      );
      if (cached.rows.length) {
        return res.json({
          trends: cached.rows[0].trends_data,
          cached: true,
          fetched_at: cached.rows[0].fetched_at,
          expires_at: cached.rows[0].expires_at,
        });
      }
    }

    // Generate fresh trends via Groq
    const trendsData = await fetchTrendsFromGroq(sectors);

    // Upsert cache
    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    await query(
      `INSERT INTO trends_cache (id, sectors, trends_data, fetched_at, expires_at)
       VALUES (uuid_generate_v4(), $1, $2, NOW(), $3)`,
      [sectorsKey, JSON.stringify(trendsData), expiresAt]
    );

    res.json({
      trends: trendsData,
      cached: false,
      fetched_at: new Date(),
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('[GET /trends]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// ─── POST /api/trends/post-ideas ─────────────────────────────────────────────
// Given a trend headline, generate 3 post topic ideas for the user
router.post('/post-ideas', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { trend_title, trend_summary } = req.body;

    if (!trend_title) return res.status(400).json({ error: 'trend_title is required' });

    const profileResult = await query(
      `SELECT full_name, user_role, years_experience, sectors FROM profiles WHERE user_id = $1`,
      [userId]
    );
    const profile = profileResult.rows[0] || {};

    const sectors = Array.isArray(profile.sectors)
      ? profile.sectors.join(', ')
      : 'supply chain';

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 600,
        temperature: 0.85,
        messages: [
          {
            role: 'system',
            content: `You are a LinkedIn content strategist for senior SCM professionals.
Output ONLY a JSON array of exactly 3 objects, each with: title (string), angle (string, 1 sentence), hook (string, opening line for the post).
No preamble, no markdown, no extra text.`,
          },
          {
            role: 'user',
            content: `Trend: "${trend_title}"
Summary: ${trend_summary || ''}
Author: ${profile.full_name || 'SCM professional'}, ${profile.user_role || 'Supply Chain Leader'}, ${profile.years_experience || '10'}+ years
Sectors: ${sectors}

Generate 3 distinct LinkedIn post ideas this author could write about this trend.`,
          },
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

    const raw = groqRes.data.choices[0].message.content.trim();
    let ideas;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      ideas = JSON.parse(cleaned);
    } catch {
      ideas = [{ title: trend_title, angle: 'Write your perspective on this trend.', hook: 'Here is what I think about ' + trend_title }];
    }

    res.json({ ideas });
  } catch (err) {
    console.error('[POST /trends/post-ideas]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate post ideas' });
  }
});

// ─── Groq helper ─────────────────────────────────────────────────────────────
async function fetchTrendsFromGroq(sectors) {
  const sectorList = Array.isArray(sectors) ? sectors.join(', ') : 'supply chain';

  const prompt = `You are a Supply Chain intelligence analyst. Generate a JSON object with current, realistic SCM industry trends.

Sectors in focus: ${sectorList || 'supply chain management generally'}

Return ONLY a valid JSON object with this exact shape (no markdown, no preamble):
{
  "generated_at": "ISO date string",
  "sectors_analyzed": ["array of sectors"],
  "headline_trend": {
    "title": "string",
    "summary": "2-3 sentence summary",
    "impact": "high|medium|low",
    "tags": ["string"]
  },
  "trends": [
    {
      "id": "t1",
      "title": "string",
      "summary": "2-3 sentence summary",
      "category": "technology|geopolitics|sustainability|labor|risk|demand|regulation",
      "impact": "high|medium|low",
      "relevance_score": 0-100,
      "tags": ["string"],
      "post_angle": "One sentence on how an SCM leader could write about this"
    }
  ],
  "quick_stats": [
    { "label": "string", "value": "string", "trend": "up|down|flat" }
  ],
  "sector_pulse": [
    { "sector": "string", "sentiment": "positive|neutral|negative|volatile", "note": "string" }
  ]
}

Include 6 trends, 4 quick stats, and sector_pulse entries for each sector in focus.
Make the data realistic and specific to current global SCM conditions (2025).`;

  const groqRes = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      temperature: 0.4,
      messages: [
        { role: 'system', content: 'You are a supply chain market intelligence analyst. Always respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const raw = groqRes.data.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Return a fallback structure
    return {
      generated_at: new Date().toISOString(),
      sectors_analyzed: Array.isArray(sectors) ? sectors : [],
      headline_trend: {
        title: 'AI-Driven Supply Chain Resilience',
        summary: 'Companies are accelerating adoption of AI tools to build more resilient and adaptive supply chains in response to ongoing global disruptions.',
        impact: 'high',
        tags: ['AI', 'resilience', 'disruption'],
      },
      trends: [],
      quick_stats: [],
      sector_pulse: [],
      error: 'Trend data could not be parsed — please refresh.',
    };
  }
}

module.exports = router;
