'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require admin token
router.use(requireAdmin);

// ══════════════════════════════════════════
// GET /api/admin/stats
// ══════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const [users, posts, feedback, active] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_beta) as beta,
             COUNT(*) FILTER (WHERE plan = 'starter') as starter,
             COUNT(*) FILTER (WHERE plan = 'pro') as pro
             FROM users WHERE is_admin = FALSE`),
      query(`SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status = 'approved') as approved,
             COUNT(*) FILTER (WHERE status = 'pending') as pending,
             COUNT(*) FILTER (WHERE status = 'discarded') as discarded
             FROM posts`),
      query(`SELECT COUNT(*) as total FROM feedback`),
      query(`SELECT COUNT(*) as total FROM users
             WHERE last_active > NOW() - INTERVAL '7 days' AND is_admin = FALSE`)
    ]);

    res.json({
      users: users.rows[0],
      posts: posts.rows[0],
      feedback: feedback.rows[0],
      active_last_7_days: active.rows[0].total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/admin/users
// ══════════════════════════════════════════
router.get('/users', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        u.id, u.email, u.full_name, u.plan, u.is_beta, u.is_active,
        u.onboarding_complete, u.created_at, u.last_active,
        p.current_role, p.sectors, p.location,
        s.status as subscription_status,
        COUNT(posts.id) as post_count
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN subscriptions s ON s.user_id = u.id
      LEFT JOIN posts ON posts.user_id = u.id
      WHERE u.is_admin = FALSE
      GROUP BY u.id, p.id, s.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/admin/users — create beta user manually
// ══════════════════════════════════════════
router.post('/users', async (req, res) => {
  const { email, full_name, password, plan = 'beta' } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const existing = await query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const hash = await bcrypt.hash(password, 12);
    const userRes = await query(`
      INSERT INTO users (email, password_hash, full_name, plan, is_beta, onboarding_complete)
      VALUES ($1, $2, $3, $4, TRUE, FALSE)
      RETURNING id, email, full_name, plan, created_at
    `, [email, hash, full_name || '', plan]);

    const user = userRes.rows[0];

    await Promise.all([
      query(`INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, $2, 'active')`, [user.id, plan]),
      query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`, [user.id, full_name || ''])
    ]);

    console.log(`[Admin] Created user: ${email} (${plan})`);
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// PATCH /api/admin/users/:id — update plan / suspend
// ══════════════════════════════════════════
router.patch('/users/:id', async (req, res) => {
  const { plan, is_active, is_beta } = req.body;
  try {
    const updates = [];
    const values  = [];
    let idx = 1;

    if (plan !== undefined)      { updates.push(`plan = $${idx++}`);      values.push(plan); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }
    if (is_beta !== undefined)   { updates.push(`is_beta = $${idx++}`);   values.push(is_beta); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.id);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, plan, is_active`,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    // Sync subscription plan
    if (plan) {
      await query(`UPDATE subscriptions SET plan = $1 WHERE user_id = $2`, [plan, req.params.id]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/admin/users/:id/profile
// ══════════════════════════════════════════
router.get('/users/:id/profile', async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, u.email, u.full_name, u.plan, u.created_at
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Profile not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/admin/feedback
// ══════════════════════════════════════════
router.get('/feedback', async (req, res) => {
  try {
    const result = await query(`
      SELECT f.*, u.email, u.full_name
      FROM feedback f
      JOIN users u ON u.id = f.user_id
      ORDER BY f.submitted_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/admin/posts — all posts across all users
// ══════════════════════════════════════════
router.get('/posts', async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, u.email, u.full_name
      FROM posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
