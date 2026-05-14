'use strict';

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const axios    = require('axios');
const { query }       = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── Multer — memory storage for PDF uploads ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

// ─── Groq helper ─────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens = 2500, temperature = 0.3) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature,
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

function parseJSON(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── POST /api/career/extract-pdf ────────────────────────────────────────────
// Extracts text from uploaded PDF file
router.post('/extract-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const data = await pdfParse(req.file.buffer);
    const text = data.text?.trim();

    if (!text || text.length < 100) {
      return res.status(400).json({
        error: 'Could not extract text from this PDF. It may be image-based (scanned). Please paste your CV text manually.',
      });
    }

    // Save to profile for reuse
    await query(
      `UPDATE profiles SET cv_raw = $1 WHERE user_id = $2`,
      [text.substring(0, 10000), req.user.id]
    ).catch(() => {});

    res.json({
      text: text.substring(0, 10000),
      pages: data.numpages,
      word_count: text.split(/\s+/).length,
    });
  } catch (err) {
    console.error('[career/extract-pdf]', err.message);
    if (err.message?.includes('Only PDF')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'PDF extraction failed. Try pasting your CV text instead.' });
  }
});

// ─── POST /api/career/analyze-cv ─────────────────────────────────────────────
// Full ATS analysis — section scores, keyword gaps, suggestions
router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    const { cv_text } = req.body;
    if (!cv_text || cv_text.trim().length < 100) {
      return res.status(400).json({ error: 'CV text is too short. Please paste your full CV.' });
    }

    // Load user profile for context
    const profileRes = await query(
      `SELECT p.user_role, p.sectors, p.location, p.years_experience, p.achievements,
              u.full_name
       FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1`,
      [req.user.id]
    );
    const profile = profileRes.rows[0] || {};
    const sectors = Array.isArray(profile.sectors)
      ? profile.sectors.join(', ')
      : Object.keys(profile.sectors || {}).join(', ');

    const profileContext = profile.user_role
      ? `The candidate is a ${profile.user_role}${sectors ? ` in ${sectors}` : ''}${profile.years_experience ? ` with ${profile.years_experience} years of experience` : ''}.`
      : 'Analyze for a general professional context.';

    const raw = await callGroq([
      {
        role: 'system',
        content: `You are a world-class ATS optimization expert and career coach. ${profileContext}
Analyze CVs with extreme precision. Return ONLY valid JSON, no markdown, no explanation outside JSON.`,
      },
      {
        role: 'user',
        content: `Analyze this CV for ATS optimization and provide detailed, actionable feedback:

${cv_text.substring(0, 5000)}

Return ONLY this exact JSON structure:
{
  "overall_score": 74,
  "grade": "B",
  "summary": "2-3 sentence honest overall assessment",
  "ats_compatibility": {
    "score": 70,
    "issues": ["Missing ATS-friendly section headers", "No quantified achievements"]
  },
  "sections": [
    {
      "name": "Professional Summary",
      "score": 65,
      "max": 100,
      "status": "needs_work",
      "feedback": "Specific feedback about this section",
      "keywords_found": ["leadership", "supply chain"],
      "keywords_missing": ["KPI", "stakeholder management", "P&L"]
    },
    {
      "name": "Work Experience",
      "score": 80,
      "max": 100,
      "status": "good",
      "feedback": "Specific feedback",
      "keywords_found": ["managed", "led", "delivered"],
      "keywords_missing": ["quantified results", "cost savings", "efficiency"]
    },
    {
      "name": "Skills",
      "score": 55,
      "max": 100,
      "status": "needs_work",
      "feedback": "Specific feedback",
      "keywords_found": [],
      "keywords_missing": ["hard skills", "tools", "certifications"]
    },
    {
      "name": "Education",
      "score": 90,
      "max": 100,
      "status": "strong",
      "feedback": "Specific feedback",
      "keywords_found": [],
      "keywords_missing": []
    }
  ],
  "suggestions": [
    {
      "id": "s1",
      "priority": "high",
      "section": "Professional Summary",
      "type": "rewrite",
      "issue": "What is wrong",
      "original": "exact text from CV",
      "suggested": "improved version",
      "reason": "Why this change dramatically improves ATS score"
    },
    {
      "id": "s2",
      "priority": "high",
      "section": "Work Experience",
      "type": "quantify",
      "issue": "Missing metrics",
      "original": "Managed supply chain operations",
      "suggested": "Managed end-to-end supply chain operations for 3 distribution centres, reducing lead times by 22% and saving $1.2M annually",
      "reason": "Quantified achievements score 3x higher in ATS systems"
    }
  ],
  "keyword_density": {
    "strong": ["leadership", "operations"],
    "weak": ["strategy", "analytics"],
    "missing_critical": ["KPI", "ROI", "stakeholder", "cross-functional"]
  },
  "quick_wins": [
    "Add LinkedIn URL to contact section",
    "Use standard section headers (Experience, not Career History)",
    "Add a core competencies / skills matrix section"
  ]
}

Generate sections for ALL sections found in the CV. Generate 8-12 suggestions mixing rewrites, additions, and quantification improvements. Be specific and reference actual text from the CV.`,
      },
    ]);

    const parsed = parseJSON(raw);

    // Save cv_raw
    await query(
      `UPDATE profiles SET cv_raw = $1 WHERE user_id = $2`,
      [cv_text.substring(0, 10000), req.user.id]
    ).catch(() => {});

    res.json({
      overall_score:   parsed.overall_score   || 60,
      grade:           parsed.grade           || 'C',
      summary:         parsed.summary         || '',
      ats_compatibility: parsed.ats_compatibility || { score: 60, issues: [] },
      sections:        parsed.sections        || [],
      suggestions:     (parsed.suggestions    || []).map(s => ({
        id:        s.id        || Math.random().toString(36).slice(2, 8),
        priority:  s.priority  || 'medium',
        section:   s.section   || 'General',
        type:      s.type      || 'improvement',
        issue:     s.issue     || '',
        original:  s.original  || '',
        suggested: s.suggested || '',
        reason:    s.reason    || '',
      })),
      keyword_density: parsed.keyword_density || { strong: [], weak: [], missing_critical: [] },
      quick_wins:      parsed.quick_wins      || [],
    });
  } catch (err) {
    console.error('[career/analyze-cv]', err?.response?.data || err.message);
    res.status(500).json({ error: 'CV analysis failed. Please try again.' });
  }
});

// ─── POST /api/career/analyze-job ────────────────────────────────────────────
// Match CV against a job description
router.post('/analyze-job', requireAuth, async (req, res) => {
  try {
    const { cv_text, job_text, approved_changes = [] } = req.body;
    if (!cv_text || cv_text.trim().length < 100) return res.status(400).json({ error: 'CV text is required.' });
    if (!job_text || job_text.trim().length < 50)  return res.status(400).json({ error: 'Job description is too short.' });

    let updatedCV = cv_text;
    if (approved_changes.length > 0) {
      updatedCV += `\n\n[APPROVED IMPROVEMENTS APPLIED: ${approved_changes.map(c => c.suggested).join(' | ')}]`;
    }

    const raw = await callGroq([
      {
        role: 'system',
        content: `You are an expert ATS specialist and career coach. Analyze the match between a CV and job description with precision.
Return ONLY valid JSON, no markdown.`,
      },
      {
        role: 'user',
        content: `Compare this CV against the job description:

CV:
${updatedCV.substring(0, 3000)}

JOB DESCRIPTION:
${job_text.substring(0, 2000)}

Return ONLY this JSON:
{
  "match_score": 68,
  "grade": "C+",
  "gap_summary": "2-3 sentence honest analysis of the match and key gaps",
  "matched_keywords": ["project management", "SAP", "stakeholder"],
  "missing_keywords": ["APICS", "Six Sigma", "demand planning", "S&OP"],
  "suggestions": [
    {
      "id": "j1",
      "section": "Professional Summary",
      "priority": "high",
      "issue": "Missing key requirement from JD",
      "suggestion": "Add this specific text/achievement to your CV",
      "reason": "The job description mentions this 4 times — it is clearly a core requirement",
      "jd_quote": "exact phrase from job description that prompted this suggestion"
    }
  ],
  "tailoring_tips": [
    "Mirror the exact job title in your Professional Summary",
    "Add a Projects section highlighting relevant experience"
  ],
  "interview_risks": [
    "You may be asked about Six Sigma — prepare a response if you have informal experience"
  ]
}
Generate 6-10 suggestions. Reference actual text from both CV and JD. Be specific and brutally honest.`,
      },
    ]);

    const parsed = parseJSON(raw);

    res.json({
      match_score:      parsed.match_score      || 50,
      grade:            parsed.grade            || 'C',
      gap_summary:      parsed.gap_summary      || '',
      matched_keywords: parsed.matched_keywords || [],
      missing_keywords: parsed.missing_keywords || [],
      suggestions:      (parsed.suggestions     || []).map(s => ({
        id:         s.id         || Math.random().toString(36).slice(2, 8),
        section:    s.section    || 'General',
        priority:   s.priority   || 'medium',
        issue:      s.issue      || '',
        suggestion: s.suggestion || '',
        reason:     s.reason     || '',
        jd_quote:   s.jd_quote   || '',
      })),
      tailoring_tips:  parsed.tailoring_tips  || [],
      interview_risks: parsed.interview_risks || [],
    });
  } catch (err) {
    console.error('[career/analyze-job]', err?.response?.data || err.message);
    res.status(500).json({ error: 'Job match analysis failed. Please try again.' });
  }
});

// ─── POST /api/career/export-pdf ─────────────────────────────────────────────
// Generates a polished CV PDF using the chosen template
router.post('/export-pdf', requireAuth, async (req, res) => {
  try {
    const { cv_text, template = 'classic', full_name, email, phone, location } = req.body;
    if (!cv_text || cv_text.trim().length < 100) {
      return res.status(400).json({ error: 'CV text is required for export.' });
    }

    // Use Groq to structure the CV content into sections
    const raw = await callGroq([
      {
        role: 'system',
        content: `You are a professional CV formatter. Parse raw CV text into structured sections.
Return ONLY valid JSON, no markdown.`,
      },
      {
        role: 'user',
        content: `Parse this CV into structured sections for PDF generation:

${cv_text.substring(0, 6000)}

Return ONLY this JSON:
{
  "name": "Full Name from CV",
  "email": "email@example.com",
  "phone": "+971 XX XXX XXXX",
  "location": "City, Country",
  "linkedin": "linkedin.com/in/username or empty string",
  "summary": "Professional summary text",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "period": "Jan 2020 – Present",
      "location": "City, Country",
      "bullets": ["Achievement 1", "Achievement 2", "Achievement 3"]
    }
  ],
  "education": [
    {
      "degree": "BSc Supply Chain Management",
      "institution": "University Name",
      "period": "2015 – 2019",
      "details": "First Class Honours"
    }
  ],
  "skills": ["Skill 1", "Skill 2", "Skill 3"],
  "certifications": ["CIPS Level 6", "PMP"],
  "languages": ["English (Native)", "Arabic (Professional)"]
}`,
      },
    ]);

    let structured;
    try {
      structured = parseJSON(raw);
    } catch {
      structured = { name: full_name || '', email: email || '', summary: cv_text.substring(0, 500), experience: [], education: [], skills: [] };
    }

    // Override with user-provided contact info if given
    if (full_name) structured.name     = full_name;
    if (email)     structured.email    = email;
    if (phone)     structured.phone    = phone;
    if (location)  structured.location = location;

    // Generate HTML for the chosen template
    const html = generateCVHTML(structured, template);

    res.json({ html, structured });
  } catch (err) {
    console.error('[career/export-pdf]', err?.response?.data || err.message);
    res.status(500).json({ error: 'PDF export failed. Please try again.' });
  }
});

// ─── CV HTML Template Generator ──────────────────────────────────────────────
function generateCVHTML(data, template) {
  const templates = {
    classic: classicTemplate(data),
    modern:  modernTemplate(data),
    minimal: minimalTemplate(data),
  };
  return templates[template] || templates.classic;
}

function classicTemplate(d) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Times New Roman', serif; font-size: 11pt; color: #1a1a1a; background: white; padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { text-align: center; border-bottom: 2px solid #1a1a1a; padding-bottom: 16px; margin-bottom: 20px; }
  .name { font-size: 26pt; font-weight: bold; letter-spacing: 1px; margin-bottom: 8px; }
  .contact { font-size: 10pt; color: #444; }
  .contact span { margin: 0 8px; }
  h2 { font-size: 12pt; font-weight: bold; text-transform: uppercase; letter-spacing: 2px; border-bottom: 1px solid #1a1a1a; margin: 18px 0 10px; padding-bottom: 4px; }
  .summary { font-size: 10.5pt; line-height: 1.6; color: #333; }
  .job { margin-bottom: 14px; }
  .job-header { display: flex; justify-content: space-between; align-items: baseline; }
  .job-title { font-weight: bold; font-size: 11pt; }
  .job-company { font-style: italic; color: #444; }
  .job-period { font-size: 10pt; color: #666; }
  ul { margin: 6px 0 0 18px; }
  li { font-size: 10.5pt; line-height: 1.5; color: #333; margin-bottom: 3px; }
  .edu-item { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .skill-tag { background: #f0f0f0; padding: 3px 10px; border-radius: 3px; font-size: 10pt; }
  .cert-list { columns: 2; }
  .cert-list li { break-inside: avoid; }
</style></head><body>
  <div class="header">
    <div class="name">${d.name || 'Your Name'}</div>
    <div class="contact">
      ${d.email ? `<span>${d.email}</span>` : ''}
      ${d.phone ? `<span>•</span><span>${d.phone}</span>` : ''}
      ${d.location ? `<span>•</span><span>${d.location}</span>` : ''}
      ${d.linkedin ? `<span>•</span><span>${d.linkedin}</span>` : ''}
    </div>
  </div>
  ${d.summary ? `<h2>Professional Summary</h2><p class="summary">${d.summary}</p>` : ''}
  ${d.experience?.length ? `<h2>Professional Experience</h2>${d.experience.map(e => `
    <div class="job">
      <div class="job-header">
        <div><span class="job-title">${e.title}</span> — <span class="job-company">${e.company}</span>${e.location ? `, ${e.location}` : ''}</div>
        <span class="job-period">${e.period}</span>
      </div>
      ${e.bullets?.length ? `<ul>${e.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
    </div>`).join('')}` : ''}
  ${d.education?.length ? `<h2>Education</h2>${d.education.map(e => `
    <div class="edu-item">
      <div><strong>${e.degree}</strong> — ${e.institution}${e.details ? ` (${e.details})` : ''}</div>
      <span style="color:#666;font-size:10pt">${e.period}</span>
    </div>`).join('')}` : ''}
  ${d.skills?.length ? `<h2>Core Skills</h2><div class="skills-grid">${d.skills.map(s => `<span class="skill-tag">${s}</span>`).join('')}</div>` : ''}
  ${d.certifications?.length ? `<h2>Certifications</h2><ul class="cert-list">${d.certifications.map(c => `<li>${c}</li>`).join('')}</ul>` : ''}
  ${d.languages?.length ? `<h2>Languages</h2><p>${d.languages.join(' • ')}</p>` : ''}
</body></html>`;
}

function modernTemplate(d) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Arial', sans-serif; font-size: 10.5pt; color: #2d3748; background: white; display: flex; min-height: 100vh; }
  .sidebar { width: 260px; min-width: 260px; background: #1e3a5f; color: white; padding: 32px 24px; }
  .main { flex: 1; padding: 32px 28px; }
  .name { font-size: 22pt; font-weight: bold; color: white; line-height: 1.2; margin-bottom: 4px; }
  .role { font-size: 11pt; color: #90cdf4; margin-bottom: 20px; }
  .contact-item { font-size: 9.5pt; color: #bee3f8; margin-bottom: 6px; word-break: break-all; }
  .sidebar h3 { font-size: 10pt; text-transform: uppercase; letter-spacing: 2px; color: #90cdf4; border-bottom: 1px solid #2d6a9f; padding-bottom: 6px; margin: 20px 0 12px; }
  .sidebar h3:first-of-type { margin-top: 0; }
  .skill-item { font-size: 9.5pt; color: #e2e8f0; margin-bottom: 5px; }
  .skill-bar { height: 4px; background: #2d6a9f; border-radius: 2px; margin-top: 3px; }
  .skill-fill { height: 100%; background: #63b3ed; border-radius: 2px; }
  .cert-item { font-size: 9.5pt; color: #e2e8f0; margin-bottom: 5px; }
  .lang-item { font-size: 9.5pt; color: #e2e8f0; margin-bottom: 5px; }
  h2 { font-size: 13pt; font-weight: bold; color: #1e3a5f; border-left: 4px solid #3182ce; padding-left: 10px; margin: 20px 0 12px; }
  h2:first-of-type { margin-top: 0; }
  .summary { font-size: 10pt; line-height: 1.7; color: #4a5568; margin-bottom: 8px; }
  .job { margin-bottom: 16px; }
  .job-title { font-weight: bold; font-size: 11pt; color: #2d3748; }
  .job-meta { font-size: 9.5pt; color: #718096; margin-bottom: 6px; }
  ul { margin-left: 16px; }
  li { font-size: 10pt; line-height: 1.5; color: #4a5568; margin-bottom: 3px; }
  .edu-item { margin-bottom: 10px; }
  .edu-degree { font-weight: bold; font-size: 10.5pt; }
  .edu-school { color: #718096; font-size: 9.5pt; }
</style></head><body>
  <div class="sidebar">
    <div class="name">${d.name || 'Your Name'}</div>
    <div class="role">${d.experience?.[0]?.title || 'Professional'}</div>
    <div class="contact-item">📧 ${d.email || ''}</div>
    ${d.phone ? `<div class="contact-item">📱 ${d.phone}</div>` : ''}
    ${d.location ? `<div class="contact-item">📍 ${d.location}</div>` : ''}
    ${d.linkedin ? `<div class="contact-item">🔗 ${d.linkedin}</div>` : ''}
    ${d.skills?.length ? `<h3>Skills</h3>${d.skills.slice(0, 12).map(s => `<div class="skill-item">${s}</div>`).join('')}` : ''}
    ${d.certifications?.length ? `<h3>Certifications</h3>${d.certifications.map(c => `<div class="cert-item">✓ ${c}</div>`).join('')}` : ''}
    ${d.languages?.length ? `<h3>Languages</h3>${d.languages.map(l => `<div class="lang-item">${l}</div>`).join('')}` : ''}
  </div>
  <div class="main">
    ${d.summary ? `<h2>Professional Summary</h2><p class="summary">${d.summary}</p>` : ''}
    ${d.experience?.length ? `<h2>Experience</h2>${d.experience.map(e => `
      <div class="job">
        <div class="job-title">${e.title}</div>
        <div class="job-meta">${e.company}${e.location ? ` • ${e.location}` : ''} • ${e.period}</div>
        ${e.bullets?.length ? `<ul>${e.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
      </div>`).join('')}` : ''}
    ${d.education?.length ? `<h2>Education</h2>${d.education.map(e => `
      <div class="edu-item">
        <div class="edu-degree">${e.degree}</div>
        <div class="edu-school">${e.institution} • ${e.period}${e.details ? ` • ${e.details}` : ''}</div>
      </div>`).join('')}` : ''}
  </div>
</body></html>`;
}

function minimalTemplate(d) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: 10.5pt; color: #111; background: white; padding: 48px 56px; max-width: 800px; margin: 0 auto; }
  .name { font-size: 28pt; font-weight: 300; letter-spacing: -1px; color: #111; margin-bottom: 6px; }
  .contact { font-size: 9.5pt; color: #888; margin-bottom: 32px; }
  .contact span { margin-right: 16px; }
  h2 { font-size: 9pt; font-weight: 600; text-transform: uppercase; letter-spacing: 3px; color: #888; margin: 28px 0 12px; }
  .divider { height: 1px; background: #e5e5e5; margin-bottom: 16px; }
  .summary { font-size: 10.5pt; line-height: 1.8; color: #333; }
  .job { display: grid; grid-template-columns: 160px 1fr; gap: 16px; margin-bottom: 16px; }
  .job-left { font-size: 9.5pt; color: #888; padding-top: 2px; }
  .job-title { font-weight: 600; font-size: 11pt; color: #111; margin-bottom: 2px; }
  .job-company { font-size: 10pt; color: #555; margin-bottom: 6px; }
  ul { margin-left: 14px; }
  li { font-size: 10pt; line-height: 1.6; color: #444; margin-bottom: 2px; }
  .edu-row { display: grid; grid-template-columns: 160px 1fr; gap: 16px; margin-bottom: 10px; }
  .skills-wrap { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill { font-size: 9.5pt; color: #555; padding: 3px 10px; border: 1px solid #ddd; border-radius: 20px; }
</style></head><body>
  <div class="name">${d.name || 'Your Name'}</div>
  <div class="contact">
    ${d.email ? `<span>${d.email}</span>` : ''}
    ${d.phone ? `<span>${d.phone}</span>` : ''}
    ${d.location ? `<span>${d.location}</span>` : ''}
    ${d.linkedin ? `<span>${d.linkedin}</span>` : ''}
  </div>
  ${d.summary ? `<h2>Profile</h2><div class="divider"></div><p class="summary">${d.summary}</p>` : ''}
  ${d.experience?.length ? `<h2>Experience</h2><div class="divider"></div>${d.experience.map(e => `
    <div class="job">
      <div class="job-left">${e.period}<br><span style="color:#aaa">${e.location || ''}</span></div>
      <div>
        <div class="job-title">${e.title}</div>
        <div class="job-company">${e.company}</div>
        ${e.bullets?.length ? `<ul>${e.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`).join('')}` : ''}
  ${d.education?.length ? `<h2>Education</h2><div class="divider"></div>${d.education.map(e => `
    <div class="edu-row">
      <div style="font-size:9.5pt;color:#888">${e.period}</div>
      <div><strong>${e.degree}</strong><br><span style="color:#777;font-size:10pt">${e.institution}${e.details ? ` — ${e.details}` : ''}</span></div>
    </div>`).join('')}` : ''}
  ${d.skills?.length ? `<h2>Skills</h2><div class="divider"></div><div class="skills-wrap">${d.skills.map(s => `<span class="skill">${s}</span>`).join('')}</div>` : ''}
  ${d.certifications?.length ? `<h2>Certifications</h2><div class="divider"></div><p style="font-size:10pt;color:#444;line-height:1.8">${d.certifications.join(' • ')}</p>` : ''}
  ${d.languages?.length ? `<h2>Languages</h2><div class="divider"></div><p style="font-size:10pt;color:#444">${d.languages.join(' • ')}</p>` : ''}
</body></html>`;
}

module.exports = router;
