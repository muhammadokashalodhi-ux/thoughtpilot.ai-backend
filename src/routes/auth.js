'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const axios  = require('axios');
const { buildWelcomeEmail } = require('../utils/emailTemplates');

const router = express.Router();

// ── Send email via Resend ──
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await axios.post('https://api.resend.com/emails', {
      from: 'ThoughtPilot AI <noreply@thoughtpilotai.com>',
      to: [to], subject, html,
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch (err) {
    console.error('[Auth] Welcome email failed:', err.message);
    // Never block signup if email fails
  }
}

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
    httpOnly: false,
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
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('full_name').trim().notEmpty().withMessage('Full name required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, full_name, invite_code, account_type } = req.body;

    // Check invite code — grants beta access if correct
    const isBeta = !!(invite_code && invite_code === process.env.BETA_INVITE_CODE);
    const plan   = isBeta ? 'beta' : 'free';
    const accType = (account_type === 'organisation') ? 'organisation' : 'personal';

    try {
      const existing = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const userRes = await query(`
        INSERT INTO users (email, password_hash, full_name, plan, is_beta, onboarding_complete, account_type)
        VALUES ($1, $2, $3, $4, $5, FALSE, $6)
        RETURNING id, email, full_name, plan, is_beta, is_admin, onboarding_complete, account_type, created_at
      `, [email, password_hash, full_name, plan, isBeta, accType]);

      const user = userRes.rows[0];

      await query(`
        INSERT INTO subscriptions (user_id, plan, status)
        VALUES ($1, $2, 'active')
      `, [user.id, plan]);

      await query(`
        INSERT INTO profiles (user_id, full_name)
        VALUES ($1, $2)
      `, [user.id, full_name]);

      if (isBeta) {
        console.log(`[Auth] Beta invite code used by: ${email}`);
      }

      const token = generateToken(user.id);
      setAuthCookie(res, token);

      console.log(`[Auth] New signup: ${email}`);

      // Send welcome email (non-blocking)
      const firstName = full_name.split(' ')[0];
      sendEmail({
        to: email,
        subject: "🎉 Welcome to ThoughtPilot AI — here is what to do next",
        html: buildWelcomeEmail({
          firstName,
          email,
          onboardingComplete: false,
        }),
      });

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
    body('email').isEmail().withMessage('Valid email required'),
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
        FROM users WHERE LOWER(email) = LOWER($1)
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

      await query(`UPDATE users SET last_active = NOW() WHERE id = $1`, [user.id]);

      const token = generateToken(user.id);
      setAuthCookie(res, token);

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
        u.account_type,
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