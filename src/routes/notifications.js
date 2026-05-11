'use strict';

const express    = require('express');
const router     = express.Router();
const { query }  = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios      = require('axios');
const nodemailer = require('nodemailer');

// ── GET /api/notifications/settings ──────────────────────────────────────────
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT wa_phone, wa_apikey, email_notifications, wa_notifications,
              post_schedule, timezone
       FROM profiles WHERE user_id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Profile not found' });

    const row = result.rows[0];
    res.json({
      settings: {
        ...row,
        wa_apikey:     row.wa_apikey ? '••••••••' + row.wa_apikey.slice(-4) : null,
        wa_apikey_set: !!row.wa_apikey,
      },
    });
  } catch (err) {
    console.error('[GET /notifications/settings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/notifications/settings ────────────────────────────────────────
router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const {
      wa_phone, wa_apikey, email_notifications, wa_notifications,
      post_schedule, timezone,
      email_from, email_app_password, email_to,
    } = req.body;

    const updates = [];
    const params  = [];

    const add = (col, val) => {
      if (val !== undefined && val !== '') {
        params.push(val);
        updates.push(`${col} = $${params.length}`);
      }
    };

    add('wa_phone',            wa_phone);
    add('wa_apikey',           wa_apikey);
    add('email_notifications', email_notifications);
    add('wa_notifications',    wa_notifications);
    add('post_schedule',       post_schedule);
    add('timezone',            timezone);

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.user.id);
    await query(
      `UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${params.length}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /notifications/settings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/test-whatsapp ─────────────────────────────────────
router.post('/test-whatsapp', requireAuth, async (req, res) => {
  try {
    // Allow passing credentials directly in the request body for testing
    const { wa_phone: bodyPhone, wa_apikey: bodyKey } = req.body;

    let wa_phone = bodyPhone;
    let wa_apikey = bodyKey;

    // If not passed in body, load from profile
    if (!wa_phone || !wa_apikey) {
      const profileResult = await query(
        `SELECT wa_phone, wa_apikey FROM profiles WHERE user_id = $1`,
        [req.user.id]
      );
      const row = profileResult.rows[0] || {};
      wa_phone  = wa_phone  || row.wa_phone;
      wa_apikey = wa_apikey || row.wa_apikey;
    }

    if (!wa_phone || !wa_apikey) {
      return res.status(400).json({
        error: 'WhatsApp phone and API key are required. Save them first.'
      });
    }

    // Clean phone — remove +, spaces, dashes
    const cleanPhone = wa_phone.replace(/[^0-9]/g, '');

    const message = encodeURIComponent(
      '✅ ThoughtPilot AI: Your WhatsApp notifications are connected! You will receive post reminders and approvals here.'
    );

    const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${message}&apikey=${wa_apikey}`;

    console.log('[WhatsApp] Sending to:', cleanPhone);
    const wmRes = await axios.get(url, { timeout: 15000 });
    console.log('[WhatsApp] Response:', wmRes.status, wmRes.data?.substring?.(0, 100));

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'whatsapp', 'Test notification', 'WhatsApp test sent', true, NOW())`,
      [req.user.id]
    ).catch(() => {});

    res.json({ success: true, message: 'WhatsApp test sent! Check your phone.' });
  } catch (err) {
    console.error('[POST /notifications/test-whatsapp]', err.message);

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, error, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'whatsapp', 'Test notification', '', false, $2, NOW())`,
      [req.user.id, err.message]
    ).catch(() => {});

    res.status(500).json({
      error: 'Failed to send WhatsApp message. Check your phone number and API key.',
      detail: err.message
    });
  }
});

// ── POST /api/notifications/test-email ───────────────────────────────────────
router.post('/test-email', requireAuth, async (req, res) => {
  try {
    const { email_from: bodyFrom, email_app_password: bodyPass, email_to: bodyTo } = req.body;

    // Use passed credentials OR fall back to env vars
    const emailFrom = bodyFrom || process.env.EMAIL_FROM;
    const emailPass = bodyPass || process.env.EMAIL_APP_PASSWORD;

    const userResult = await query(
      `SELECT email, full_name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = userResult.rows[0];
    const emailTo = bodyTo || user?.email;

    if (!emailFrom || !emailPass) {
      return res.status(400).json({
        error: 'Email credentials not configured. Add Gmail address and App Password in Settings → Notifications.'
      });
    }

    if (!emailTo) {
      return res.status(400).json({ error: 'No recipient email address found.' });
    }

    console.log('[Email] Sending from:', emailFrom, 'to:', emailTo);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailFrom, pass: emailPass },
      connectionTimeout: 10000,  // 10 s to establish TCP connection
      greetingTimeout:    8000,  // 8 s to receive SMTP greeting
      socketTimeout:     15000,  // 15 s socket inactivity before abort
    });

    await transporter.sendMail({
      from:    `ThoughtPilot AI <${emailFrom}>`,
      to:      emailTo,
      subject: '✅ ThoughtPilot AI — Email notifications connected',
      html: `
        <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; color: #111; padding: 20px;">
          <h2 style="color: #2563eb;">ThoughtPilot AI</h2>
          <p>Hi ${user?.full_name || 'there'},</p>
          <p>Your email notifications are now connected! 🎉</p>
          <p>You will receive notifications here when:</p>
          <ul>
            <li>A new LinkedIn post is generated and ready for review</li>
            <li>Your weekly content calendar is reset every Sunday</li>
          </ul>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #6b7280; font-size: 13px;">ThoughtPilot AI — Your LinkedIn Co-pilot</p>
        </div>
      `,
    });

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'email', 'Test email', 'Email test sent', true, NOW())`,
      [req.user.id]
    ).catch(() => {});

    res.json({ success: true, message: `Test email sent to ${emailTo}` });
  } catch (err) {
    console.error('[POST /notifications/test-email]', err.message);

    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, error, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'email', 'Test email', '', false, $2, NOW())`,
      [req.user.id, err.message]
    ).catch(() => {});

    res.status(500).json({
      error: 'Failed to send email. Check your Gmail address and App Password.',
      detail: err.message
    });
  }
});

// ── POST /api/notifications/save-email-config ─────────────────────────────────
// Save email credentials to profiles table
router.post('/save-email-config', requireAuth, async (req, res) => {
  try {
    const { email_from, email_app_password, email_to } = req.body;
    if (!email_from || !email_app_password) {
      return res.status(400).json({ error: 'Email address and App Password are required' });
    }

    // Store in profiles — add columns if they don't exist
    await query(`
      ALTER TABLE profiles
        ADD COLUMN IF NOT EXISTS notif_email_from     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS notif_email_password VARCHAR(255),
        ADD COLUMN IF NOT EXISTS notif_email_to       VARCHAR(255)
    `).catch(() => {}); // ignore if columns already exist

    await query(
      `UPDATE profiles
       SET notif_email_from     = $1,
           notif_email_password = $2,
           notif_email_to       = $3
       WHERE user_id = $4`,
      [email_from, email_app_password, email_to || email_from, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[POST /notifications/save-email-config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/notifications/log ────────────────────────────────────────────────
router.get('/log', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, type, channel, subject, success, error, sent_at
       FROM notification_log WHERE user_id = $1
       ORDER BY sent_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ log: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
