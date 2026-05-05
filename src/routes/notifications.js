const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios = require('axios');
const nodemailer = require('nodemailer');

// ─── GET /api/notifications/settings ─────────────────────────────────────────
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(
      `SELECT wa_phone, wa_apikey, email_notifications, wa_notifications,
              post_schedule, timezone
       FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Profile not found' });

    // Mask the apikey — show only last 4 chars
    const row = result.rows[0];
    const maskedKey = row.wa_apikey
      ? '••••••••' + row.wa_apikey.slice(-4)
      : null;

    res.json({
      settings: {
        ...row,
        wa_apikey: maskedKey,
        wa_apikey_set: !!row.wa_apikey,
      },
    });
  } catch (err) {
    console.error('[GET /notifications/settings]', err.message);
    res.status(500).json({ error: 'Failed to load notification settings' });
  }
});

// ─── PATCH /api/notifications/settings ───────────────────────────────────────
router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      wa_phone, wa_apikey, email_notifications, wa_notifications,
      post_schedule, timezone,
    } = req.body;

    const updates = [];
    const params = [];

    const add = (col, val) => {
      if (val !== undefined) { params.push(val); updates.push(`${col} = $${params.length}`); }
    };

    add('wa_phone', wa_phone);
    add('wa_apikey', wa_apikey);
    add('email_notifications', email_notifications);
    add('wa_notifications', wa_notifications);
    add('post_schedule', post_schedule);
    add('timezone', timezone);

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(userId);
    await query(
      `UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${params.length}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /notifications/settings]', err.message);
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

// ─── POST /api/notifications/test-whatsapp ───────────────────────────────────
router.post('/test-whatsapp', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profileResult = await query(
      `SELECT wa_phone, wa_apikey FROM profiles WHERE user_id = $1`,
      [userId]
    );

    const { wa_phone, wa_apikey } = profileResult.rows[0] || {};
    if (!wa_phone || !wa_apikey) {
      return res.status(400).json({ error: 'WhatsApp phone and API key are required. Please save them first.' });
    }

    const message = encodeURIComponent(
      `✅ ThoughtPilot AI: Your WhatsApp notifications are connected! You'll receive post reminders and approvals here.`
    );

    const url = `https://api.callmebot.com/whatsapp.php?phone=${wa_phone}&text=${message}&apikey=${wa_apikey}`;
    const wmRes = await axios.get(url, { timeout: 15000 });

    // Log the attempt
    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'whatsapp', 'Test notification', 'WhatsApp test sent', true, NOW())`,
      [userId]
    );

    res.json({ success: true, message: 'WhatsApp test sent! Check your phone.' });
  } catch (err) {
    console.error('[POST /notifications/test-whatsapp]', err.message);

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, error, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'whatsapp', 'Test notification', '', false, $2, NOW())`,
      [req.user.id, err.message]
    ).catch(() => {});

    res.status(500).json({ error: 'Failed to send WhatsApp test. Check your phone number and API key.' });
  }
});

// ─── POST /api/notifications/test-email ──────────────────────────────────────
router.post('/test-email', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user email
    const userResult = await query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
    const user = userResult.rows[0];
    if (!user?.email) return res.status(400).json({ error: 'No email on file' });

    if (!process.env.EMAIL_FROM || !process.env.EMAIL_APP_PASSWORD) {
      return res.status(503).json({ error: 'Email service not configured on the server.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `ThoughtPilot AI <${process.env.EMAIL_FROM}>`,
      to: user.email,
      subject: '✅ ThoughtPilot — Email notifications connected',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
          <h2 style="color: #2563eb;">ThoughtPilot AI</h2>
          <p>Hi ${user.full_name || 'there'},</p>
          <p>Your email notifications are now connected! 🎉</p>
          <p>You'll receive reminders for scheduled posts and approval requests here.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #6b7280; font-size: 13px;">ThoughtPilot AI — Your LinkedIn Co-pilot</p>
        </div>
      `,
    });

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'email', 'Test email', 'Email test sent', true, NOW())`,
      [userId]
    );

    res.json({ success: true, message: `Test email sent to ${user.email}` });
  } catch (err) {
    console.error('[POST /notifications/test-email]', err.message);
    res.status(500).json({ error: 'Failed to send test email. Check server email configuration.' });
  }
});

// ─── GET /api/notifications/log ──────────────────────────────────────────────
router.get('/log', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(
      `SELECT id, type, channel, subject, success, error, sent_at
       FROM notification_log WHERE user_id = $1
       ORDER BY sent_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ log: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notification log' });
  }
});

module.exports = router;
