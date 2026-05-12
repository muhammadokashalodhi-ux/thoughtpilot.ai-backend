'use strict';

const express         = require('express');
const router          = express.Router();
const { query }       = require('../db');
const { requireAuth } = require('../middleware/auth');
const axios           = require('axios');

// ─── Resend helper ────────────────────────────────────────────────────────────
async function sendEmailViaResend({ to, toName, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured on server');
  }
  const res = await axios.post(
    'https://api.resend.com/emails',
    {
      from:    'ThoughtPilot AI <noreply@thoughtpilotai.com>',
      to:      toName ? [`${toName} <${to}>`] : [to],
      subject,
      html,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Resend error: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ─── GET /api/notifications/settings ─────────────────────────────────────────
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT wa_phone, wa_apikey, email_notifications, wa_notifications,
              post_schedule, timezone, notification_email
       FROM profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Profile not found' });
    const row = result.rows[0];
    res.json({
      settings: {
        wa_notifications:    row.wa_notifications    ?? false,
        wa_phone:            row.wa_phone            || null,
        wa_apikey_set:       !!row.wa_apikey,
        email_notifications: row.email_notifications ?? false,
        notification_email:  row.notification_email  || null,
        post_schedule:       row.post_schedule,
        timezone:            row.timezone             || 'Asia/Dubai',
        email_service_ready: !!process.env.RESEND_API_KEY,
      },
    });
  } catch (err) {
    console.error('[GET /notifications/settings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/notifications/settings ───────────────────────────────────────
router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const {
      wa_phone, wa_apikey,
      email_notifications, wa_notifications,
      notification_email, post_schedule, timezone,
    } = req.body;

    const updates = [];
    const params  = [];
    const add = (col, val) => {
      if (val !== undefined) { params.push(val); updates.push(`${col} = $${params.length}`); }
    };

    if (wa_phone !== undefined) {
      params.push(wa_phone ? wa_phone.replace(/[^0-9]/g, '') : null);
      updates.push(`wa_phone = $${params.length}`);
    }
    add('wa_apikey',           wa_apikey);
    add('email_notifications', email_notifications);
    add('wa_notifications',    wa_notifications);
    add('notification_email',  notification_email);
    add('post_schedule',       post_schedule);
    add('timezone',            timezone);

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.user.id);
    await query(`UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${params.length}`, params);
    res.json({ success: true });
  } catch (err) {
    console.error('[PATCH /notifications/settings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/notifications/test-whatsapp ────────────────────────────────────
router.post('/test-whatsapp', requireAuth, async (req, res) => {
  try {
    const profileResult = await query(
      `SELECT wa_phone, wa_apikey FROM profiles WHERE user_id = $1`, [req.user.id]
    );
    const row = profileResult.rows[0] || {};
    if (!row.wa_phone || !row.wa_apikey) {
      return res.status(400).json({ error: 'WhatsApp phone and API key are required. Save them first.' });
    }
    const cleanPhone = row.wa_phone.replace(/[^0-9]/g, '');
    const message    = encodeURIComponent(
      '✅ ThoughtPilot AI: Your WhatsApp notifications are connected! You will receive post reminders and weekly calendar updates here.'
    );
    const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${message}&apikey=${row.wa_apikey}`;
    const wmRes = await axios.get(url, { timeout: 15000 });
    const body = typeof wmRes.data === 'string' ? wmRes.data.toLowerCase() : '';
    if (body.includes('error') || body.includes('invalid') || body.includes('wrong')) {
      throw new Error(`CallMeBot: ${wmRes.data}`);
    }
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
    res.status(500).json({ error: 'Failed to send WhatsApp message. Check your phone number (no + sign) and API key.' });
  }
});

// ─── POST /api/notifications/test-email ──────────────────────────────────────
router.post('/test-email', requireAuth, async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'Email service not configured on server.' });
    }
    const [userResult, profileResult] = await Promise.all([
      query(`SELECT email, full_name FROM users WHERE id = $1`, [req.user.id]),
      query(`SELECT notification_email FROM profiles WHERE user_id = $1`, [req.user.id]),
    ]);
    const user           = userResult.rows[0];
    const notifEmail     = profileResult.rows[0]?.notification_email;
    const recipientEmail = notifEmail || user?.email;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'No notification email address on file.' });
    }
    await sendEmailViaResend({
      to:      recipientEmail,
      toName:  user?.full_name || '',
      subject: '✅ ThoughtPilot AI — Email notifications connected',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:28px 32px;">
            <div style="font-size:24px;margin-bottom:6px;">🔗</div>
            <div style="color:white;font-size:20px;font-weight:800;letter-spacing:-0.5px;">ThoughtPilot AI</div>
            <div style="color:rgba(255,255,255,0.7);font-size:13px;">Your LinkedIn Co-pilot</div>
          </div>
          <div style="padding:28px 32px;">
            <p style="font-size:16px;color:#111;margin:0 0 16px;">Hi ${user?.full_name || 'there'} 👋</p>
            <p style="color:#374151;line-height:1.7;margin:0 0 20px;">
              Your email notifications are connected! You'll receive updates at <strong>${recipientEmail}</strong>.
            </p>
            <div style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
              <p style="font-weight:700;color:#111;margin:0 0 12px;font-size:14px;">You'll be notified when:</p>
              <div style="font-size:13px;color:#374151;line-height:2;">
                ✍️ &nbsp;A new LinkedIn post is ready for your review<br/>
                📅 &nbsp;Your weekly content calendar resets every Sunday<br/>
                ⚡ &nbsp;A scheduled post is due for publishing
              </div>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin:0;">
              Sent from noreply@thoughtpilotai.com · <a href="https://www.thoughtpilotai.com" style="color:#2563eb;">thoughtpilotai.com</a>
            </p>
          </div>
        </div>
      `,
    });
    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'email', 'Test email', $2, true, NOW())`,
      [req.user.id, `Test email sent to ${recipientEmail}`]
    ).catch(() => {});
    res.json({ success: true, message: `Test email sent to ${recipientEmail}` });
  } catch (err) {
    console.error('[POST /notifications/test-email]', err.message);
    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, error, sent_at)
       VALUES (uuid_generate_v4(), $1, 'test', 'email', 'Test email', '', false, $2, NOW())`,
      [req.user.id, err.message]
    ).catch(() => {});
    res.status(500).json({ error: 'Failed to send email. Please try again.' });
  }
});

// ─── GET /api/notifications/log ──────────────────────────────────────────────
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
