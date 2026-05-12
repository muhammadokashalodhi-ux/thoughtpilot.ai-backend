// PATCH for src/routes/notifications.js
// Update GET /api/notifications/settings and PATCH /api/notifications/settings
// to include auto_schedule and post_time fields

// ─── GET /api/notifications/settings ─────────────────────────────────────────
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT wa_phone, wa_apikey, wa_notifications, email_notifications,
              email_from, auto_schedule, post_time
       FROM profiles WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[GET /notifications/settings]', err.message);
    res.status(500).json({ error: 'Failed to load notification settings' });
  }
});

// ─── PATCH /api/notifications/settings ───────────────────────────────────────
router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const {
      wa_phone, wa_apikey,
      wa_notifications, email_notifications,
      email_from,
      auto_schedule, post_time,
    } = req.body;

    const { rows } = await query(
      `UPDATE profiles SET
         wa_phone           = COALESCE($1, wa_phone),
         wa_apikey          = COALESCE($2, wa_apikey),
         wa_notifications   = COALESCE($3, wa_notifications),
         email_notifications = COALESCE($4, email_notifications),
         email_from         = COALESCE($5, email_from),
         auto_schedule      = COALESCE($6, auto_schedule),
         post_time          = COALESCE($7, post_time),
         updated_at         = NOW()
       WHERE user_id = $8
       RETURNING wa_phone, wa_apikey, wa_notifications, email_notifications,
                 email_from, auto_schedule, post_time`,
      [wa_phone, wa_apikey, wa_notifications, email_notifications,
       email_from, auto_schedule, post_time, req.user.id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[PATCH /notifications/settings]', err.message);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});
