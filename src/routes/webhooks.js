/**
 * POST /api/webhooks/paddle
 *
 * CRITICAL: This route must receive the RAW request body for signature verification.
 * Register this route BEFORE express.json() in src/index.js, or use express.raw().
 *
 * In src/index.js add this BEFORE the global json middleware:
 *
 *   const paddleWebhookRouter = require('./routes/webhooks');
 *   app.use('/api/webhooks', paddleWebhookRouter);
 *
 *   app.use(express.json()); // ← global json parser comes after
 */

const express = require('express');
const router = express.Router();
const { processPaddleWebhook } = require('../webhooks/paddle');

router.post(
  '/paddle',
  express.raw({ type: 'application/json' }), // raw body for sig verification
  async (req, res) => {
    try {
      const rawBody = req.body.toString('utf8');
      const signature = req.headers['paddle-signature'];

      await processPaddleWebhook(rawBody, signature);

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Paddle Webhook Error]', err.message);

      if (err.message.includes('Invalid Paddle webhook signature')) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Return 200 anyway to prevent Paddle retrying on our own errors
      res.status(200).json({ received: true, warning: 'Processing error logged' });
    }
  }
);

module.exports = router;
