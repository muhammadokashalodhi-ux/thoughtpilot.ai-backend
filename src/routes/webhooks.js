'use strict';

/**
 * routes/webhooks.js
 *
 * POST /api/webhooks/stripe
 *
 * CRITICAL: Must be registered BEFORE express.json() in src/index.js
 * so the raw body is preserved for Stripe signature verification.
 *
 * In src/index.js:
 *   const webhookRouter = require('./routes/webhooks');
 *   app.use('/api/webhooks', webhookRouter);   // ← BEFORE express.json()
 *   app.use(express.json());
 */

const express = require('express');
const router  = express.Router();
const { processStripeWebhook } = require('../webhooks/stripe');

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const rawBody   = req.body;
      const signature = req.headers['stripe-signature'];

      if (!signature) {
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }

      await processStripeWebhook(rawBody, signature);

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Webhook] Stripe error:', err.message);

      if (err.message.includes('signature verification failed')) {
        return res.status(400).json({ error: 'Invalid signature' });
      }

      if (err.message.includes('STRIPE_WEBHOOK_SECRET is not set')) {
        return res.status(500).json({ error: 'Webhook not configured' });
      }

      // Return 200 for processing errors so Stripe doesn't retry endlessly
      res.status(200).json({ received: true, warning: 'Processing error — check logs' });
    }
  }
);

module.exports = router;
