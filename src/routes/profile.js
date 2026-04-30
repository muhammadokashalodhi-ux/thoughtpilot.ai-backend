'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/profile ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM profiles WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/profile — upsert all profile fields ────────────────────────────
router.post('/', async (req, res) => {
  const {
    full_name, location, user_role, years_experience,
    user_headline, sectors,
    companies, countries, achievements, credentials,
    cv_raw, projects, awards,
    voice_boldness, voice_tone, post_length, style_notes,
    content_pillars,
    wa_phone, wa_apikey, email_notifications, wa_notifications,
  } = req.body;

  try {
    await query(
      `INSERT INTO profiles (
        user_id, full_name, location, user_role, years_experience,
        user_headline, sectors,
        companies, countries, achievements, credentials,
        cv_raw, projects, awards,
        voice_boldness, voice_tone, post_length, style_notes,
        content_pillars,
        wa_phone, wa_apikey, email_notifications, wa_notifications,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23, NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        full_name           = COALESCE(EXCLUDED.full_name,           profiles.full_name),
        location            = COALESCE(EXCLUDED.location,            profiles.location),
        user_role           = COALESCE(EXCLUDED.user_role,           profiles.user_role),
        years_experience    = COALESCE(EXCLUDED.years_experience,    profiles.years_experience),
        user_headline       = COALESCE(EXCLUDED.user_headline,       profiles.user_headline),
        sectors             = COALESCE(EXCLUDED.sectors,             profiles.sectors),
        companies           = COALESCE(EXCLUDED.companies,           profiles.companies),
        countries           = COALESCE(EXCLUDED.countries,           profiles.countries),
        achievements        = COALESCE(EXCLUDED.achievements,        profiles.achievements),
        credentials         = COALESCE(EXCLUDED.credentials,         profiles.credentials),
        cv_raw              = COALESCE(EXCLUDED.cv_raw,              profiles.cv_raw),
        projects            = COALESCE(EXCLUDED.projects,            profiles.projects),
        awards              = COALESCE(EXCLUDED.awards,              profiles.awards),
        voice_boldness      = COALESCE(EXCLUDED.voice_boldness,      profiles.voice_boldness),
        voice_tone          = COALESCE(EXCLUDED.voice_tone,          profiles.voice_tone),
        post_length         = COALESCE(EXCLUDED.post_length,         profiles.post_length),
        style_notes         = COALESCE(EXCLUDED.style_notes,         profiles.style_notes),
        content_pillars     = COALESCE(EXCLUDED.content_pillars,     profiles.content_pillars),
        wa_phone            = COALESCE(EXCLUDED.wa_phone,            profiles.wa_phone),
        wa_apikey           = COALESCE(EXCLUDED.wa_apikey,           profiles.wa_apikey),
        email_notifications = COALESCE(EXCLUDED.email_notifications, profiles.email_notifications),
        wa_notifications    = COALESCE(EXCLUDED.wa_notifications,    profiles.wa_notifications),
        updated_at          = NOW()`,
      [
        req.user.id, full_name, location, user_role, years_experience,
        user_headline,
        sectors ? JSON.stringify(sectors) : null,
        companies, countries, achievements, credentials,
        cv_raw, projects, awards,
        voice_boldness, voice_tone, post_length, style_notes,
        content_pillars ? JSON.stringify(content_pillars) : null,
        wa_phone, wa_apikey, email_notifications, wa_notifications,
      ]
    );

    if (full_name) {
      await query(
        `UPDATE users SET full_name = $1 WHERE id = $2`,
        [full_name, req.user.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Profile] Upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/profile — partial update ────────────────────────────────────────
router.put('/', async (req, res) => {
  // Same as POST — delegates to upsert logic
  req.method = 'POST';
  router.handle(req, res);
});

// ── POST /api/profile/complete-onboarding ────────────────────────────────────
router.post('/complete-onboarding', async (req, res) => {
  try {
    await query(
      `UPDATE users
       SET onboarding_complete = TRUE, onboarding_completed_at = NOW()
       WHERE id = $1`,
      [req.user.id]
    );
    await query(
      `INSERT INTO profiles (user_id, updated_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id]
    );
    res.json({ success: true, message: 'Onboarding complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/profile/pillars ──────────────────────────────────────────────────
router.get('/pillars', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM pillars
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY display_order ASC, created_at ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/profile/pillars ─────────────────────────────────────────────────
router.post('/pillars', [
  body('pillar_name').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { pillar_name, pillar_icon, description, prompt, display_order } = req.body;

  try {
    const count = await query(
      `SELECT COUNT(*) AS cnt FROM pillars WHERE user_id = $1 AND is_active = TRUE`,
      [req.user.id]
    );
    if (parseInt(count.rows[0].cnt) >= 8) {
      return res.status(400).json({ error: 'Maximum 8 pillars allowed' });
    }

    const result = await query(
      `INSERT INTO pillars (user_id, pillar_name, pillar_icon, description, prompt, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, pillar_name, pillar_icon || '📌', description, prompt, display_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/profile/pillars/:id ──────────────────────────────────────────────
router.put('/pillars/:id', async (req, res) => {
  const { pillar_name, pillar_icon, description, prompt, display_order, is_active } = req.body;
  try {
    const result = await query(
      `UPDATE pillars SET
        pillar_name   = COALESCE($1, pillar_name),
        pillar_icon   = COALESCE($2, pillar_icon),
        description   = COALESCE($3, description),
        prompt        = COALESCE($4, prompt),
        display_order = COALESCE($5, display_order),
        is_active     = COALESCE($6, is_active)
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [pillar_name, pillar_icon, description, prompt, display_order, is_active, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pillar not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/profile/pillars/:id ──────────────────────────────────────────
router.delete('/pillars/:id', async (req, res) => {
  try {
    await query(
      `UPDATE pillars SET is_active = FALSE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/profile/feedback ────────────────────────────────────────────────
router.post('/feedback', async (req, res) => {
  const { week_number, rating, what_worked, what_broke, what_missing, general_notes } = req.body;
  try {
    const result = await query(
      `INSERT INTO feedback
         (user_id, week_number, rating, what_worked, what_broke, what_missing, general_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, week_number, rating, what_worked, what_broke, what_missing, general_notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
