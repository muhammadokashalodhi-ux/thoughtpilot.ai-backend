const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

// ─── GET /api/settings ────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [userResult, profileResult] = await Promise.all([
      query(`SELECT id, email, full_name, plan, is_beta, created_at FROM users WHERE id = $1`, [userId]),
      query(`SELECT * FROM profiles WHERE user_id = $1`, [userId]),
    ]);

    const user = userResult.rows[0];
    const profile = profileResult.rows[0] || {};

    res.json({ user, profile });
  } catch (err) {
    console.error('[GET /settings]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ─── PATCH /api/settings/account ──────────────────────────────────────────────
// Update email, full_name on users table
router.patch('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, email } = req.body;

    const updates = [];
    const params = [];

    if (full_name !== undefined) { params.push(full_name); updates.push(`full_name = $${params.length}`); }
    if (email !== undefined) {
      // Check email uniqueness
      const exists = await query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [email, userId]);
      if (exists.rows.length) return res.status(409).json({ error: 'Email already in use by another account.' });
      params.push(email.toLowerCase());
      updates.push(`email = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(userId);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id, email, full_name, plan, is_beta`,
      params
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[PATCH /settings/account]', err.message);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// ─── PATCH /api/settings/password ────────────────────────────────────────────
router.patch('/password', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const userResult = await query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    const user = userResult.rows[0];

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]);

    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /settings/password]', err.message);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// ─── PATCH /api/settings/voice ────────────────────────────────────────────────
// Voice & writing style settings
router.patch('/voice', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { voice_boldness, voice_tone, post_length, style_notes } = req.body;

    const updates = [];
    const params = [];

    const add = (col, val) => {
      if (val !== undefined) { params.push(val); updates.push(`${col} = $${params.length}`); }
    };

    add('voice_boldness', voice_boldness);
    add('voice_tone', voice_tone);
    add('post_length', post_length);
    add('style_notes', style_notes);

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(userId);
    await query(`UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${params.length}`, params);

    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /settings/voice]', err.message);
    res.status(500).json({ error: 'Failed to save voice settings' });
  }
});

// ─── PATCH /api/settings/profile ─────────────────────────────────────────────
// Career / profile fields
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      full_name, location, user_role, years_experience, user_headline,
      sectors, companies, countries, achievements, credentials, cv_raw,
      projects, awards,
    } = req.body;

    const updates = [];
    const params = [];

    const add = (col, val) => {
      if (val !== undefined) { params.push(val); updates.push(`${col} = $${params.length}`); }
    };

    add('full_name', full_name);
    add('location', location);
    add('user_role', user_role);
    add('years_experience', years_experience);
    add('user_headline', user_headline);
    add('sectors', sectors ? JSON.stringify(sectors) : undefined);
    add('companies', companies);
    add('countries', countries);
    add('achievements', achievements);
    add('credentials', credentials);
    add('cv_raw', cv_raw);
    add('projects', projects);
    add('awards', awards);

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(userId);
    await query(`UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${params.length}`, params);

    // Also sync full_name to users table if provided
    if (full_name) {
      await query(`UPDATE users SET full_name = $1 WHERE id = $2`, [full_name, userId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /settings/profile]', err.message);
    res.status(500).json({ error: 'Failed to save profile settings' });
  }
});

// ─── DELETE /api/settings/account ────────────────────────────────────────────
// Soft-delete — deactivate account
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required to delete account' });

    const userResult = await query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    const valid = await bcrypt.compare(password, userResult.rows[0]?.password_hash || '');
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    await query(`UPDATE users SET is_active = false WHERE id = $1`, [userId]);

    res.json({ success: true, message: 'Account deactivated.' });
  } catch (err) {
    console.error('[DELETE /settings/account]', err.message);
    res.status(500).json({ error: 'Failed to deactivate account' });
  }
});

module.exports = router;
