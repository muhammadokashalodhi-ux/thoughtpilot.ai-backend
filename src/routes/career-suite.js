const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');

// ─── POST /api/career/analyze-cv ─────────────────────────────────────────────
// Analyzes CV text and returns ATS improvements + grammar fixes
router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    const { cv_text } = req.body;

    if (!cv_text || cv_text.trim().length < 100) {
      return res.status(400).json({ error: 'CV text is too short. Please paste your full CV content.' });
    }

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `You are an expert CV/resume reviewer specializing in ATS optimization across industries and geographies.
Return ONLY valid JSON, no markdown, no explanation.`,
          },
          {
            role: 'user',
            content: `Analyze this CV and return specific, actionable changes:

${cv_text.substring(0, 4000)}

Return ONLY this JSON structure:
{
  "overall_score": 72,
  "summary": "2-3 sentence honest assessment",
  "changes": [
    {
      "id": "c1",
      "section": "Professional Summary",
      "type": "ats",
      "original": "exact text from CV that needs changing",
      "suggested": "improved version",
      "reason": "Why this change improves ATS score or clarity"
    },
    {
      "id": "c2",
      "section": "Work Experience",
      "type": "grammar",
      "original": "text with error",
      "suggested": "corrected text",
      "reason": "Grammar correction explanation"
    },
    {
      "id": "c3",
      "section": "Skills",
      "type": "improvement",
      "original": "current skills section",
      "suggested": "improved version with ATS keywords",
      "reason": "Missing high-value ATS keywords for the target role"
    }
  ]
}
Generate 6-10 specific changes. Mix grammar corrections, ATS improvements, and content improvements.`,
          },
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
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    // Also save cv_raw to the user's profile for future use
    if (req.user?.id) {
      await query(
        `UPDATE profiles SET cv_raw = $1 WHERE user_id = $2`,
        [cv_text.substring(0, 10000), req.user.id]
      ).catch(() => {}); // non-blocking
    }

    res.json({
      overall_score: parsed.overall_score || 65,
      summary: parsed.summary || '',
      changes: (parsed.changes || []).map((c) => ({
        id: c.id || Math.random().toString(36).slice(2, 8),
        section: c.section || 'General',
        type: c.type || 'improvement',
        original: c.original || '',
        suggested: c.suggested || '',
        reason: c.reason || '',
      })),
    });
  } catch (err) {
    console.error('[POST /career/analyze-cv]', err?.response?.data || err.message);
    res.status(500).json({ error: 'CV analysis failed. Please try again.' });
  }
});

// ─── POST /api/career/analyze-job ────────────────────────────────────────────
// Compares CV against a job description and returns targeted suggestions
router.post('/analyze-job', requireAuth, async (req, res) => {
  try {
    const { cv_text, job_text, approved_changes = [] } = req.body;

    if (!cv_text || cv_text.trim().length < 100) {
      return res.status(400).json({ error: 'CV text is required.' });
    }
    if (!job_text || job_text.trim().length < 50) {
      return res.status(400).json({ error: 'Job description is too short.' });
    }

    // Build updated CV with approved changes applied
    let updatedCV = cv_text;
    if (approved_changes.length > 0) {
      updatedCV += `\n\n[APPROVED IMPROVEMENTS: ${approved_changes.map((c) => c.suggested).join('; ')}]`;
    }

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `You are an expert career coach and ATS specialist. Analyze the match between a CV and job description.
Return ONLY valid JSON, no markdown.`,
          },
          {
            role: 'user',
            content: `Compare this CV against the job description and suggest specific additions/changes to improve match:

CV:
${updatedCV.substring(0, 2000)}

JOB DESCRIPTION:
${job_text.substring(0, 1500)}

Return ONLY this JSON:
{
  "match_score": 68,
  "gap_summary": "2-3 sentence analysis of key gaps",
  "suggestions": [
    {
      "id": "j1",
      "section": "Professional Summary",
      "suggestion": "Add this specific text to your CV",
      "reason": "This keyword appears 3 times in the job description",
      "priority": "high"
    }
  ]
}
Generate 5-8 specific, actionable suggestions. Focus on keywords, skills, and experiences the job requires that are missing or undersold in the CV.`,
          },
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
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    res.json({
      match_score: parsed.match_score || 60,
      gap_summary: parsed.gap_summary || '',
      suggestions: (parsed.suggestions || []).map((s) => ({
        id: s.id || Math.random().toString(36).slice(2, 8),
        section: s.section || 'General',
        suggestion: s.suggestion || '',
        reason: s.reason || '',
        priority: s.priority || 'medium',
      })),
    });
  } catch (err) {
    console.error('[POST /career/analyze-job]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Job match analysis failed. Please try again.' });
  }
});

module.exports = router;
