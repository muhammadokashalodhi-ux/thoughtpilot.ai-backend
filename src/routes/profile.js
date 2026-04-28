'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ══════════════════════════════════════════
// GET /api/profile
// ══════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM profiles WHERE user_id = $1
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// PUT /api/profile — full profile update
// ══════════════════════════════════════════
router.put('/', [
  body('sectors').optional().isArray(),
  body('voice_boldness').optional().isInt({ min: 1, max: 10 }),
  body('years_experience').optional().isInt({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    full_name, location, user_role, years_experience,
    career_highlights, companies_worked, countries_worked,
    credentials, sectors, voice_tone, voice_boldness,
    voice_length, linkedin_url, wa_phone, wa_apikey,
    email_notifications, wa_notifications, post_schedule, timezone
  } = req.body;

  try {
    const result = await query(`
      UPDATE profiles SET
        full_name           = COALESCE($1,  full_name),
        location            = COALESCE($2,  location),
        user_role           = COALESCE($3,  user_role),
        years_experience    = COALESCE($4,  years_experience),
        career_highlights   = COALESCE($5,  career_highlights),
        companies_worked    = COALESCE($6,  companies_worked),
        countries_worked    = COALESCE($7,  countries_worked),
        credentials         = COALESCE($8,  credentials),
        sectors             = COALESCE($9,  sectors),
        voice_tone          = COALESCE($10, voice_tone),
        voice_boldness      = COALESCE($11, voice_boldness),
        voice_length        = COALESCE($12, voice_length),
        linkedin_url        = COALESCE($13, linkedin_url),
        wa_phone            = COALESCE($14, wa_phone),
        wa_apikey           = COALESCE($15, wa_apikey),
        email_notifications = COALESCE($16, email_notifications),
        wa_notifications    = COALESCE($17, wa_notifications),
        post_schedule       = COALESCE($18, post_schedule),
        timezone            = COALESCE($19, timezone)
      WHERE user_id = $20
      RETURNING *
    `, [
      full_name, location, user_role, years_experience,
      career_highlights,
      companies_worked  ? JSON.stringify(companies_worked)  : null,
      countries_worked  ? JSON.stringify(countries_worked)  : null,
      credentials,
      sectors           ? JSON.stringify(sectors)           : null,
      voice_tone, voice_boldness, voice_length,
      linkedin_url, wa_phone, wa_apikey,
      email_notifications, wa_notifications,
      post_schedule, timezone,
      req.user.id
    ]);

    // Also update display name on users table
    if (full_name) {
      await query(`UPDATE users SET full_name = $1 WHERE id = $2`, [full_name, req.user.id]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Profile] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/profile/complete-onboarding
// Called after onboarding wizard is finished
// ══════════════════════════════════════════
router.post('/complete-onboarding', async (req, res) => {
  try {
    await query(
      `UPDATE users SET onboarding_complete = TRUE WHERE id = $1`,
      [req.user.id]
    );
    res.json({ message: 'Onboarding complete', onboarding_complete: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/profile/pillars
// ══════════════════════════════════════════
router.get('/pillars', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM pillars
      WHERE user_id = $1 AND is_active = TRUE
      ORDER BY display_order ASC, created_at ASC
    `, [req.user.id]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/profile/pillars — create new pillar
// ══════════════════════════════════════════
router.post('/pillars', [
  body('pillar_name').trim().notEmpty().withMessage('Pillar name required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { pillar_name, pillar_icon, description, prompt, display_order } = req.body;

  try {
    // Max 8 pillars per user
    const count = await query(
      `SELECT COUNT(*) as cnt FROM pillars WHERE user_id = $1 AND is_active = TRUE`,
      [req.user.id]
    );
    if (parseInt(count.rows[0].cnt) >= 8) {
      return res.status(400).json({ error: 'Maximum 8 pillars allowed' });
    }

    const result = await query(`
      INSERT INTO pillars (user_id, pillar_name, pillar_icon, description, prompt, display_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, pillar_name, pillar_icon || '📌', description, prompt, display_order || 0]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// PUT /api/profile/pillars/:id — update pillar
// ══════════════════════════════════════════
router.put('/pillars/:id', async (req, res) => {
  const { pillar_name, pillar_icon, description, prompt, display_order, is_active } = req.body;

  try {
    const result = await query(`
      UPDATE pillars SET
        pillar_name   = COALESCE($1, pillar_name),
        pillar_icon   = COALESCE($2, pillar_icon),
        description   = COALESCE($3, description),
        prompt        = COALESCE($4, prompt),
        display_order = COALESCE($5, display_order),
        is_active     = COALESCE($6, is_active)
      WHERE id = $7 AND user_id = $8
      RETURNING *
    `, [pillar_name, pillar_icon, description, prompt, display_order, is_active, req.params.id, req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Pillar not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// DELETE /api/profile/pillars/:id
// ══════════════════════════════════════════
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

// ══════════════════════════════════════════
// POST /api/profile/feedback — submit beta feedback
// ══════════════════════════════════════════
router.post('/feedback', async (req, res) => {
  const { week_number, rating, what_worked, what_broke, what_missing, general_notes } = req.body;

  try {
    const result = await query(`
      INSERT INTO feedback (user_id, week_number, rating, what_worked, what_broke, what_missing, general_notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [req.user.id, week_number, rating, what_worked, what_broke, what_missing, general_notes]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
