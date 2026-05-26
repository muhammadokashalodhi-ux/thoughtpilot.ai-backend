// src/routes/passwordReset.js
// Add to src/index.js: app.use('/api/auth', require('./routes/passwordReset'));

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { query } = require('../db/index');
const { Resend } = require('resend');
const { buildPasswordResetEmail } = require('../utils/emailTemplates');

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://thoughtpilotai.com';
const TOKEN_TTL_MINUTES = 30;

// ─── POST /api/auth/forgot-password ────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // Always return success to avoid user enumeration
    const { rows } = await query(
      'SELECT id, full_name FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      // Still 200 — don't reveal whether email exists
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

    // Store token — create table if it doesn't exist yet (idempotent)
    await query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Invalidate any existing tokens for this user
    await query(
      'UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false',
      [user.id]
    );

    // Insert new token
    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;
    const firstName = (user.full_name || 'there').split(' ')[0];

    await resend.emails.send({
      from: 'ThoughtPilot AI <noreply@thoughtpilotai.com>',
      to:   email.toLowerCase().trim(),
      subject: 'Reset your ThoughtPilot AI password',
      html: buildPasswordResetEmail({ firstName, resetLink: resetLink, ttlMinutes: TOKEN_TTL_MINUTES }),
    });

    return res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('[forgot-password]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── POST /api/auth/reset-password ─────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const { rows } = await query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used
       FROM password_reset_tokens prt
       WHERE prt.token = $1`,
      [token]
    );

    if (rows.length === 0)      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    const record = rows[0];
    if (record.used)            return res.status(400).json({ error: 'This reset link has already been used.' });
    if (new Date() > new Date(record.expires_at))
                                return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

    const hash = await bcrypt.hash(password, 12);

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, record.user_id]);
    await query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [record.id]);

    return res.json({ message: 'Password updated successfully. You can now sign in.' });
  } catch (err) {
    console.error('[reset-password]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── GET /api/auth/verify-reset-token ──────────────────────────────────────
// Called on page load to validate token before showing the form
router.get('/verify-reset-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false, error: 'No token provided' });

  try {
    const { rows } = await query(
      `SELECT expires_at, used FROM password_reset_tokens WHERE token = $1`,
      [token]
    );

    if (rows.length === 0)           return res.json({ valid: false, error: 'Invalid reset link.' });
    if (rows[0].used)                return res.json({ valid: false, error: 'This link has already been used.' });
    if (new Date() > new Date(rows[0].expires_at))
                                     return res.json({ valid: false, error: 'This link has expired.' });

    return res.json({ valid: true });
  } catch (err) {
    console.error('[verify-reset-token]', err);
    return res.status(500).json({ valid: false, error: 'Server error.' });
  }
});

// ─── Email HTML builder ─────────────────────────────────────────────────────
function buildResetEmail(firstName, resetLink, ttlMinutes) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:520px;background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;text-align:center;background:linear-gradient(135deg,#1e3a5f,#2d1b4e);">
              <div style="display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:12px;font-size:24px;margin-bottom:16px;">🔗</div>
              <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.1em;color:#94a3b8;text-transform:uppercase;">ThoughtPilot AI</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#f1f5f9;letter-spacing:-0.5px;">
                Reset your password, ${firstName}
              </h1>
              <p style="margin:0 0 28px;font-size:14px;color:#94a3b8;line-height:1.6;">
                We received a request to reset your password. Click the button below — this link is valid for <strong style="color:#e2e8f0;">${ttlMinutes} minutes</strong>.
              </p>
              <!-- CTA -->
              <div style="text-align:center;margin:0 0 28px;">
                <a href="${resetLink}"
                   style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:-0.2px;box-shadow:0 4px 20px rgba(59,130,246,0.35);">
                  Reset Password →
                </a>
              </div>
              <p style="margin:0 0 8px;font-size:12px;color:#64748b;text-align:center;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:11px;color:#475569;text-align:center;word-break:break-all;background:#0f172a;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                ${resetLink}
              </p>
              <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:0 0 24px;" />
              <p style="margin:0;font-size:12px;color:#64748b;line-height:1.6;">
                If you didn't request this, you can safely ignore this email — your password won't change.<br/>
                For security, never share this link with anyone.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 40px 28px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#475569;">
                © ${new Date().getFullYear()} ThoughtPilot AI · thoughtpilotai.com
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = router;