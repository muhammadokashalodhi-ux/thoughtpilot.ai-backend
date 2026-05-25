// src/utils/notify.js
// Sends WhatsApp (CallMeBot) and/or email (Resend) notifications
// Logs every attempt to notification_log table

const https = require('https');
const { query } = require('../db/index');

// ─── WhatsApp via CallMeBot ────────────────────────────────────────────────

async function sendWhatsApp({ phone, apikey, message }) {
  return new Promise((resolve) => {
    if (!phone || !apikey) {
      return resolve({ success: false, error: 'Missing phone or apikey' });
    }

    // Strip + prefix — CallMeBot requires no +
    const cleanPhone = String(phone).replace(/^\+/, '');
    const encodedMsg = encodeURIComponent(message);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedMsg}&apikey=${apikey}`;

    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        // CallMeBot returns HTTP 200 even on failure — check body
        const failed = body.toLowerCase().includes('error') || body.toLowerCase().includes('wrong');
        if (failed) {
          resolve({ success: false, error: body.trim() });
        } else {
          resolve({ success: true });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timed out' });
    });
  });
}

// ─── Email via Resend ──────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  return new Promise((resolve) => {
    if (!to || !subject || !html) {
      return resolve({ success: false, error: 'Missing to, subject, or html' });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return resolve({ success: false, error: 'RESEND_API_KEY not set' });
    }

    const body = JSON.stringify({
      from: 'ThoughtPilot AI <noreply@thoughtpilotai.com>',
      to: [to],
      subject,
      html,
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timed out' });
    });

    req.write(body);
    req.end();
  });
}

// ─── Log to notification_log ───────────────────────────────────────────────

async function logNotification({ userId, type, channel, subject, body, success, error }) {
  try {
    await query(
      `INSERT INTO notification_log (id, user_id, type, channel, subject, body, success, error, sent_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
      [userId, type, channel, subject || null, body || null, success, error || null]
    );
  } catch (err) {
    console.error('[notify] Failed to log notification:', err.message);
  }
}

// ─── Main dispatcher ───────────────────────────────────────────────────────

/**
 * Send a notification to a user via their enabled channels
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.type        — e.g. 'scheduled_post'
 * @param {string} opts.subject     — email subject
 * @param {string} opts.message     — plain text for WA
 * @param {string} opts.html        — HTML for email
 * @param {Object} opts.profile     — must include: wa_phone, wa_apikey, wa_notifications,
 *                                    email_notifications, email (users.email — the recipient)
 */
async function sendNotification({ userId, type, subject, message, html, profile }) {
  const results = [];

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  if (profile.wa_notifications && profile.wa_phone && profile.wa_apikey) {
    const result = await sendWhatsApp({
      phone:   profile.wa_phone,
      apikey:  profile.wa_apikey,
      message,
    });
    await logNotification({
      userId,
      type,
      channel: 'whatsapp',
      body:    message,
      success: result.success,
      error:   result.error,
    });
    results.push({ channel: 'whatsapp', ...result });
    if (!result.success) {
      console.warn(`[notify] WA failed for user ${userId}:`, result.error);
    }
  }

  // ── Email ─────────────────────────────────────────────────────────────────
  // FIX: use profile.email (users.email — the actual account email) as recipient.
  // profile.email_from is an SMTP sender credential, NOT the recipient address.
  const recipientEmail = profile.email;
  if (profile.email_notifications && recipientEmail) {
    const result = await sendEmail({
      to:      recipientEmail,
      subject,
      html,
    });
    await logNotification({
      userId,
      type,
      channel: 'email',
      subject,
      body:    html,
      success: result.success,
      error:   result.error,
    });
    results.push({ channel: 'email', ...result });
    if (!result.success) {
      console.warn(`[notify] Email failed for user ${userId}:`, result.error);
    }
  }

  return results;
}

module.exports = { sendNotification, sendWhatsApp, sendEmail, logNotification };
