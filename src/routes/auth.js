'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ── Helper ──
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

// ── Cookie helper ──
function setAuthCookie(res, token) {
  res.cookie('tp_token', token, {
    httpOnly: false,  // ← 
    secure:   true,
    sameSite: 'lax',
    domain:   '.thoughtpilotai.com',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  });
}

// ══════════════════════════════════════════
// POST /api/auth/signup
// ══════════════════════════════════════════
router.post('/signup',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('full_name').trim().notEmpty().withMessage('Full name required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, full_name } = req.body;

    try {
      // Check if email already exists
      const existing = await query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      // Create user
      const userRes = await query(`
        INSERT INTO users (email, password_hash, full_name, plan, is_beta, onboarding_complete)
        VALUES ($1, $2, $3, 'beta', TRUE, FALSE)
        RETURNING id, email, full_name, plan, is_beta, is_admin, onboarding_complete, created_at
      `, [email, password_hash, full_name]);

      const user = userRes.rows[0];

      // Create subscription record
      await query(`
        INSERT INTO subscriptions (user_id, plan, status)
        VALUES ($1, 'beta', 'active')
      `, [user.id]);

      // Create empty profile
      await query(`
        INSERT INTO profiles (user_id, full_name)
        VALUES ($1, $2)
      `, [user.id, full_name]);

      const token = generateToken(user.id);

      setAuthCookie(res, token); // ← set subdomain-scoped cookie

      console.log(`[Auth] New signup: ${email}`);

      res.status(201).json({
        message: 'Account created successfully',
        token,
        user: sanitizeUser(user)
      });

    } catch (err) {
      console.error('[Auth] Signup error:', err.message);
      res.status(500).json({ error: 'Signup failed — please try again' });
    }
  }
);

// ══════════════════════════════════════════
// POST /api/auth/login
// ══════════════════════════════════════════
router.post('/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const { email, password } = req.body;

    try {
      const result = await query(`
        SELECT id, email, password_hash, full_name, plan, is_beta,
               is_admin, is_active, onboarding_complete, created_at
        FROM users WHERE email = $1
      `, [email]);

      if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];

      if (!user.is_active) {
        return res.status(403).json({ error: 'Account suspended — contact support' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Update last active
      await query(`UPDATE users SET last_active = NOW() WHERE id = $1`, [user.id]);

      const token = generateToken(user.id);

      setAuthCookie(res, token); // ← set subdomain-scoped cookie

      console.log(`[Auth] Login: ${email}`);

      res.json({
        token,
        user: sanitizeUser(user)
      });

    } catch (err) {
      console.error('[Auth] Login error:', err.message);
      res.status(500).json({ error: 'Login failed — please try again' });
    }
  }
);

// ══════════════════════════════════════════
// GET /api/auth/me
// ══════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        u.id, u.email, u.full_name, u.plan, u.is_beta, u.is_admin,
        u.onboarding_complete, u.created_at, u.last_active,
        p.user_role, p.sectors, p.location, p.voice_tone,
        p.voice_boldness, p.voice_length, p.linkedin_url,
        p.wa_phone, p.email_notifications, p.wa_notifications,
        s.status as subscription_status, s.current_period_end
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = $1
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// ══════════════════════════════════════════
// POST /api/auth/admin-login
// ══════════════════════════════════════════
router.post('/admin-login',
  authLimiter,
  [
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const { password } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }

    const token = jwt.sign(
      { role: 'admin', timestamp: Date.now() },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, message: 'Admin access granted' });
  }
);

// ══════════════════════════════════════════
// POST /api/auth/change-password
// ══════════════════════════════════════════
router.post('/change-password',
  requireAuth,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 8 }),
  ],
  async (req, res) => {
    const { current_password, new_password } = req.body;

    try {
      const result = await query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [req.user.id]
      );

      const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const new_hash = await bcrypt.hash(new_password, 12);
      await query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [new_hash, req.user.id]
      );

      res.json({ message: 'Password updated successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update password' });
    }
  }
);

module.exports = router;