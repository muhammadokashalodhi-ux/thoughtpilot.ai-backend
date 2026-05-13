'use strict';

const jwt  = require('jsonwebtoken');
const { query } = require('../db');

// ── Standard user auth ──
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB on every request
    const result = await query(
      `SELECT id, email, full_name, plan, is_beta, is_admin, is_active, onboarding_complete
       FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    // Update last active (fire and forget)
    query(`UPDATE users SET last_active = NOW() WHERE id = $1`, [user.id]).catch(() => {});

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Admin auth — separate hardcoded password ──
async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      `SELECT id, email, full_name, is_admin, is_active FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    if (!user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}


// ── Onboarding check — redirect if not complete ──
function requireOnboarding(req, res, next) {
  if (!req.user.onboarding_complete) {
    return res.status(403).json({
      error: 'Onboarding not complete',
      code: 'ONBOARDING_REQUIRED'
    });
  }
  next();
}

// ── Plan check ──
function requirePlan(...plans) {
  return (req, res, next) => {
    if (!plans.includes(req.user.plan) && !req.user.is_admin) {
      return res.status(403).json({
        error: 'This feature requires a higher plan',
        code: 'PLAN_REQUIRED',
        required: plans
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireAdmin, requireOnboarding, requirePlan };
