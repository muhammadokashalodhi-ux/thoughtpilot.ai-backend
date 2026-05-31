'use strict';

/**
 * routes/org.js — Organisation Mode Routes
 *
 * GET    /api/org/profile          — get org profile
 * POST   /api/org/profile          — create or update org profile
 * GET    /api/org/members          — list team members
 * POST   /api/org/members/invite   — invite a team member (admin only)
 * DELETE /api/org/members/:userId  — remove a team member (admin only)
 * GET    /api/org/seats            — get seat usage
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const axios    = require('axios');
const { query }       = require('../db/index');
const { requireAuth } = require('../middleware/auth');

// ── Feature flag guard ────────────────────────────────────────────────────
function requireOrgMode(req, res, next) {
  if (process.env.ORG_MODE_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Organisation mode is not available yet' });
  }
  next();
}

// ── Require org account type ──────────────────────────────────────────────
function requireOrgAccount(req, res, next) {
  if (req.user.account_type !== 'organisation') {
    return res.status(403).json({ error: 'This endpoint is for organisation accounts only' });
  }
  next();
}

// ── Require admin role within org ─────────────────────────────────────────
async function requireOrgAdmin(req, res, next) {
  try {
    const org = await getOrgForUser(req.user.id);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const member = await query(
      `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [org.id, req.user.id]
    );

    if (!member.rows.length || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.org = org;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Helper: get org for a user ────────────────────────────────────────────
async function getOrgForUser(userId) {
  const result = await query(
    `SELECT o.* FROM organisations o
     JOIN org_members m ON m.org_id = o.id
     WHERE m.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ── Helper: send invite email ─────────────────────────────────────────────
async function sendInviteEmail({ to, inviterName, companyName, inviteUrl }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await axios.post('https://api.resend.com/emails', {
      from:    'ThoughtPilot AI <noreply@thoughtpilotai.com>',
      to:      [to],
      subject: `${inviterName} invited you to join ${companyName} on ThoughtPilot AI`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0f172a;color:#f1f5f9;border-radius:12px">
          <h2 style="color:#2563eb;margin-bottom:8px">You have been invited</h2>
          <p style="color:#94a3b8;margin-bottom:24px">
            <strong style="color:#f1f5f9">${inviterName}</strong> has invited you to join
            <strong style="color:#f1f5f9">${companyName}</strong> on ThoughtPilot AI.
          </p>
          <a href="${inviteUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
            Accept Invitation
          </a>
          <p style="color:#475569;font-size:12px;margin-top:24px">
            This invitation expires in 7 days. If you did not expect this, you can ignore this email.
          </p>
        </div>
      `,
    }, {
      headers: {
        Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  } catch (err) {
    console.error('[org] Invite email failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/org/profile
// ═══════════════════════════════════════════════════════════════════════════
router.get('/profile',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation profile not found' });

      const seats = await query(
        `SELECT total_seats, used_seats FROM org_seats WHERE org_id = $1`,
        [org.id]
      );

      const member = await query(
        `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [org.id, req.user.id]
      );

      res.json({
        ...org,
        seats:    seats.rows[0]  || { total_seats: 3, used_seats: 1 },
        my_role:  member.rows[0]?.role || 'member',
      });
    } catch (err) {
      console.error('[org] GET /profile', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/org/profile
// Create org profile on first call, update on subsequent calls
// ═══════════════════════════════════════════════════════════════════════════
router.post('/profile',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    const {
      company_name, industry, org_type, products, services,
      brand_voice, target_audience, linkedin_url, website, company_size,
    } = req.body;

    try {
      const existing = await getOrgForUser(req.user.id);

      if (existing) {
        // Update existing org
        const updated = await query(
          `UPDATE organisations SET
            company_name    = COALESCE($1, company_name),
            industry        = COALESCE($2, industry),
            org_type        = COALESCE($3, org_type),
            products        = COALESCE($4, products),
            services        = COALESCE($5, services),
            brand_voice     = COALESCE($6, brand_voice),
            target_audience = COALESCE($7, target_audience),
            linkedin_url    = COALESCE($8, linkedin_url),
            website         = COALESCE($9, website),
            company_size    = COALESCE($10, company_size),
            updated_at      = NOW()
           WHERE id = $11
           RETURNING *`,
          [
            company_name, industry, org_type, products, services,
            brand_voice, target_audience, linkedin_url, website, company_size,
            existing.id,
          ]
        );
        return res.json(updated.rows[0]);
      }

      // Create new org
      const newOrg = await query(
        `INSERT INTO organisations
           (user_id, company_name, industry, org_type, products, services,
            brand_voice, target_audience, linkedin_url, website, company_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          req.user.id, company_name, industry, org_type || 'other',
          products, services, brand_voice || 'professional',
          target_audience, linkedin_url, website, company_size,
        ]
      );

      const org = newOrg.rows[0];

      // Add creator as admin member
      await query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [org.id, req.user.id]
      );

      // Create seat record
      await query(
        `INSERT INTO org_seats (org_id, total_seats, used_seats) VALUES ($1, 3, 1)`,
        [org.id]
      );

      console.log(`[org] New organisation created: ${company_name} by user ${req.user.id}`);

      res.status(201).json(org);
    } catch (err) {
      console.error('[org] POST /profile', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/org/members
// ═══════════════════════════════════════════════════════════════════════════
router.get('/members',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const members = await query(
        `SELECT
           u.id, u.email, u.full_name, u.created_at,
           m.role, m.joined_at
         FROM org_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1
         ORDER BY m.role DESC, m.joined_at ASC`,
        [org.id]
      );

      const seats = await query(
        `SELECT total_seats, used_seats FROM org_seats WHERE org_id = $1`,
        [org.id]
      );

      res.json({
        members:     members.rows,
        total_seats: seats.rows[0]?.total_seats || 3,
        used_seats:  seats.rows[0]?.used_seats  || 1,
      });
    } catch (err) {
      console.error('[org] GET /members', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/org/members/invite
// Admin only — sends invite email, creates pending invite token
// ═══════════════════════════════════════════════════════════════════════════
router.post('/members/invite',
  requireAuth, requireOrgMode, requireOrgAccount, requireOrgAdmin,
  async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
      const org = req.org;

      // Check seat availability
      const seats = await query(
        `SELECT total_seats, used_seats FROM org_seats WHERE org_id = $1`,
        [org.id]
      );
      const seatRow = seats.rows[0];
      if (seatRow && seatRow.used_seats >= seatRow.total_seats) {
        return res.status(403).json({
          error:       'seat_limit_reached',
          message:     'No seats available — add more seats to invite team members',
          total_seats: seatRow.total_seats,
          used_seats:  seatRow.used_seats,
          upgrade_url: '/dashboard/billing',
        });
      }

      // Check if user already exists in org
      const existingUser = await query(
        `SELECT u.id FROM users u
         JOIN org_members m ON m.user_id = u.id
         WHERE LOWER(u.email) = LOWER($1) AND m.org_id = $2`,
        [email, org.id]
      );
      if (existingUser.rows.length) {
        return res.status(409).json({ error: 'This user is already a member of your organisation' });
      }

      // Generate invite token (expires in 7 days)
      const token    = crypto.randomBytes(32).toString('hex');
      const expires  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Store invite in notification_log for tracking
      await query(
        `INSERT INTO notification_log
           (id, user_id, type, channel, subject, body, success, sent_at)
         VALUES (uuid_generate_v4(), $1, 'org_invite', 'email', $2, $3, true, NOW())`,
        [
          req.user.id,
          `Org invite to ${email}`,
          JSON.stringify({ org_id: org.id, email, token, expires: expires.toISOString() }),
        ]
      );

      const inviteUrl = `${process.env.FRONTEND_URL}/join?token=${token}&org=${org.id}&email=${encodeURIComponent(email)}`;

      await sendInviteEmail({
        to:           email,
        inviterName:  req.user.full_name || 'Your colleague',
        companyName:  org.company_name   || 'your organisation',
        inviteUrl,
      });

      console.log(`[org] Invite sent to ${email} for org ${org.id}`);

      res.json({
        success: true,
        message: `Invitation sent to ${email}`,
      });
    } catch (err) {
      console.error('[org] POST /members/invite', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/org/members/:userId
// Admin only — remove a team member
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/members/:userId',
  requireAuth, requireOrgMode, requireOrgAccount, requireOrgAdmin,
  async (req, res) => {
    const { userId } = req.params;

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove yourself from the organisation' });
    }

    try {
      const org = req.org;

      const removed = await query(
        `DELETE FROM org_members
         WHERE org_id = $1 AND user_id = $2 AND role != 'admin'
         RETURNING user_id`,
        [org.id, userId]
      );

      if (!removed.rows.length) {
        return res.status(404).json({ error: 'Member not found or cannot remove an admin' });
      }

      // Decrement used seats
      await query(
        `UPDATE org_seats SET used_seats = GREATEST(used_seats - 1, 1), updated_at = NOW()
         WHERE org_id = $1`,
        [org.id]
      );

      console.log(`[org] Member ${userId} removed from org ${org.id}`);

      res.json({ success: true, message: 'Team member removed' });
    } catch (err) {
      console.error('[org] DELETE /members/:userId', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/org/seats
// ═══════════════════════════════════════════════════════════════════════════
router.get('/seats',
  requireAuth, requireOrgMode, requireOrgAccount,
  async (req, res) => {
    try {
      const org = await getOrgForUser(req.user.id);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });

      const seats = await query(
        `SELECT total_seats, used_seats FROM org_seats WHERE org_id = $1`,
        [org.id]
      );

      const row = seats.rows[0] || { total_seats: 3, used_seats: 1 };

      res.json({
        total_seats:     row.total_seats,
        used_seats:      row.used_seats,
        available_seats: row.total_seats - row.used_seats,
        extra_seat_price_id: process.env.STRIPE_ORG_EXTRA_SEAT_PRICE_ID || null,
      });
    } catch (err) {
      console.error('[org] GET /seats', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/org/join  — accept an invite token
// ═══════════════════════════════════════════════════════════════════════════
router.post('/join',
  requireAuth,
  async (req, res) => {
    const { token, org_id } = req.body;
    if (!token || !org_id) {
      return res.status(400).json({ error: 'token and org_id are required' });
    }

    try {
      // Find the invite in notification_log
      const inviteLog = await query(
        `SELECT * FROM notification_log
         WHERE type = 'org_invite'
           AND user_id IN (SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'admin')
         ORDER BY sent_at DESC
         LIMIT 50`,
        [org_id]
      );

      // Find matching token
      const invite = inviteLog.rows.find(row => {
        try {
          const data = JSON.parse(row.body);
          return data.token === token
            && data.org_id === org_id
            && new Date(data.expires) > new Date()
            && data.email.toLowerCase() === req.user.email.toLowerCase();
        } catch { return false; }
      });

      if (!invite) {
        return res.status(400).json({ error: 'Invalid or expired invitation link' });
      }

      // Check seat availability
      const seats = await query(
        `SELECT total_seats, used_seats FROM org_seats WHERE org_id = $1`,
        [org_id]
      );
      const seatRow = seats.rows[0];
      if (seatRow && seatRow.used_seats >= seatRow.total_seats) {
        return res.status(403).json({ error: 'No seats available in this organisation' });
      }

      // Add member
      await query(
        `INSERT INTO org_members (org_id, user_id, role, invited_by)
         VALUES ($1, $2, 'member', $3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [org_id, req.user.id, invite.user_id]
      );

      // Update account_type to organisation
      await query(
        `UPDATE users SET account_type = 'organisation' WHERE id = $1`,
        [req.user.id]
      );

      // Increment seats
      await query(
        `UPDATE org_seats SET used_seats = used_seats + 1, updated_at = NOW()
         WHERE org_id = $1`,
        [org_id]
      );

      console.log(`[org] User ${req.user.id} joined org ${org_id}`);

      res.json({ success: true, message: 'You have joined the organisation', org_id });
    } catch (err) {
      console.error('[org] POST /join', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
