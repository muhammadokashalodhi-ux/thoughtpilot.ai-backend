'use strict';

/**
 * routes/webhooks.js
 *
 * POST /api/webhooks/paddle
 *
 * CRITICAL: Must be registered BEFORE express.json() in src/index.js
 * so the raw body is preserved for Paddle signature verification.
 *
 * In src/index.js:
 *   const webhookRouter = require('./routes/webhooks');
 *   app.use('/api/webhooks', webhookRouter);   // ← BEFORE express.json()
 *   app.use(express.json());
 */

const express = require('express');
const router  = express.Router();
const { processPaddleWebhook } = require('../webhooks/paddle');

router.post(
  '/paddle',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const rawBody   = req.body.toString('utf8');
      const signature = req.headers['paddle-signature'];

      await processPaddleWebhook(rawBody, signature);

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Webhook] Paddle error:', err.message);

      if (err.message.includes('Invalid Paddle webhook signature')) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      if (err.message.includes('PADDLE_WEBHOOK_SECRET is not set')) {
        return res.status(500).json({ error: 'Webhook not configured' });
      }

      // Return 200 for all other errors so Paddle doesn't retry endlessly
      // The error is logged above for investigation
      res.status(200).json({ received: true, warning: 'Processing error — check logs' });
    }
  }
);

module.exports = router;
