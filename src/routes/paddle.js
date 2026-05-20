const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../db/index');
const { requireAuth } = require('../middleware/auth');

// ─── Paddle Configuration ────────────────────────────────────────────────────
// Get these from Paddle Dashboard → Developer Tools → Authentication
const PADDLE_VENDOR_ID = process.env.PADDLE_VENDOR_ID;
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_PUBLIC_KEY = process.env.PADDLE_PUBLIC_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// Paddle Price IDs (get these after creating products in Paddle Dashboard)
const PRICE_IDS = {
  starter_monthly: process.env.PADDLE_STARTER_MONTHLY_PRICE_ID,
  starter_annual: process.env.PADDLE_STARTER_ANNUAL_PRICE_ID,
  pro_monthly: process.env.PADDLE_PRO_MONTHLY_PRICE_ID,
  pro_annual: process.env.PADDLE_PRO_ANNUAL_PRICE_ID,
};

// Paddle environment (sandbox or production)
const PADDLE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
const PADDLE_BASE_URL = PADDLE_ENV === 'production' 
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

// ─── Helper: Call Paddle API ─────────────────────────────────────────────────
async function paddleRequest(endpoint, method = 'GET', body = null) {
  const url = `${PADDLE_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Paddle API error: ${res.status} ${err}`);
  }
  return res.json();
}

// ─── Create Checkout Session ─────────────────────────────────────────────────
// POST /api/paddle/checkout
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan, interval } = req.body; // plan: 'starter'|'pro', interval: 'monthly'|'annual'
  const userId = req.user.id;

  const priceKey = `${plan}_${interval}`;
  const priceId = PRICE_IDS[priceKey];

  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan or interval' });
  }

  try {
    // Get user info
    const userRes = await query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    // Check if user already has a Paddle customer ID
    let customerId = null;
    const subRes = await query(
      'SELECT paddle_customer_id FROM subscriptions WHERE user_id = $1',
      [userId]
    );
    if (subRes.rows[0]?.paddle_customer_id) {
      customerId = subRes.rows[0].paddle_customer_id;
    }

    // Create Paddle Checkout (Paddle Billing API)
    const checkoutData = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: customerId ? { id: customerId } : { email: user.email },
      custom_data: {
        user_id: userId,
        plan,
        interval,
      },
      settings: {
        success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success&plan=${plan}`,
        // Paddle doesn't have a cancel URL in the same way — user just closes the window
      },
    };

    const checkout = await paddleRequest('/transactions', 'POST', checkoutData);

    // Return the checkout URL
    res.json({ url: checkout.data.checkout.url });
  } catch (err) {
    console.error('Paddle checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── Get Subscription Portal URL ─────────────────────────────────────────────
// POST /api/paddle/portal
router.post('/portal', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const subRes = await query(
      'SELECT paddle_subscription_id FROM subscriptions WHERE user_id = $1',
      [userId]
    );

    if (!subRes.rows[0]?.paddle_subscription_id) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Paddle doesn't have a "portal" like Stripe — users manage via their Paddle receipt link
    // which is sent to them by email. For programmatic access, you'd use the subscription
    // update/cancel endpoint. For now, return the subscription management URL:
    const subscriptionId = subRes.rows[0].paddle_subscription_id;
    
    // Option 1: Direct them to update/cancel via API (not a portal URL)
    // Option 2: Tell them to check their email for Paddle receipt
    // For this implementation, we'll return a message
    res.json({ 
      message: 'Check your email for the Paddle receipt with a manage subscription link',
      subscription_id: subscriptionId,
      // Alternatively, implement cancel/update endpoints below
    });
  } catch (err) {
    console.error('Paddle portal error:', err);
    res.status(500).json({ error: 'Failed to access subscription management' });
  }
});

// ─── Cancel Subscription ─────────────────────────────────────────────────────
// POST /api/paddle/cancel
router.post('/cancel', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const subRes = await query(
      'SELECT paddle_subscription_id FROM subscriptions WHERE user_id = $1',
      [userId]
    );

    if (!subRes.rows[0]?.paddle_subscription_id) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const subscriptionId = subRes.rows[0].paddle_subscription_id;

    // Cancel the subscription in Paddle
    await paddleRequest(`/subscriptions/${subscriptionId}/cancel`, 'POST', {
      effective_from: 'next_billing_period', // Cancel at end of current period
    });

    // Update database
    await query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true, message: 'Subscription will cancel at the end of the billing period' });
  } catch (err) {
    console.error('Paddle cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── Get Current Subscription ────────────────────────────────────────────────
// GET /api/paddle/subscription
router.get('/subscription', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await query(
      `SELECT s.plan, s.status, s.current_period_end, s.paddle_subscription_id,
              u.plan as user_plan
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1`,
      [userId]
    );

    if (!result.rows[0]) {
      return res.json({ plan: 'free', status: 'active', subscription: null });
    }

    const sub = result.rows[0];
    res.json({
      plan: sub.user_plan,
      status: sub.status,
      current_period_end: sub.current_period_end,
      subscription_id: sub.paddle_subscription_id,
    });
  } catch (err) {
    console.error('Get subscription error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── Webhook Handler ─────────────────────────────────────────────────────────
// POST /api/paddle/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['paddle-signature'];
  
  // Verify webhook signature
  if (!verifyPaddleWebhook(req.body, signature)) {
    console.error('Invalid Paddle webhook signature');
    return res.status(401).send('Unauthorized');
  }

  const event = JSON.parse(req.body.toString());
  const eventType = event.event_type;

  try {
    switch (eventType) {

      // ── Transaction completed (subscription created) ──────────────────────
      case 'transaction.completed': {
        const transaction = event.data;
        const userId = transaction.custom_data?.user_id;
        const plan = transaction.custom_data?.plan;

        if (!userId || !plan) break;

        const customerId = transaction.customer_id;
        const subscriptionId = transaction.subscription_id;

        // Fetch subscription details for billing cycle end date
        const subDetails = await paddleRequest(`/subscriptions/${subscriptionId}`);
        const periodEnd = new Date(subDetails.data.current_billing_period.ends_at);

        // Upsert subscriptions table
        await query(
          `INSERT INTO subscriptions
             (id, user_id, plan, paddle_customer_id, paddle_subscription_id, status, current_period_end)
           VALUES (uuid_generate_v4(), $1, $2, $3, $4, 'active', $5)
           ON CONFLICT (user_id) DO UPDATE SET
             plan = $2,
             paddle_customer_id = $3,
             paddle_subscription_id = $4,
             status = 'active',
             current_period_end = $5`,
          [userId, plan, customerId, subscriptionId, periodEnd]
        );

        // Update users.plan
        await query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);

        console.log(`✅ Subscription activated: user ${userId} → ${plan}`);
        break;
      }

      // ── Subscription updated (upgrade/downgrade) ──────────────────────────
      case 'subscription.updated': {
        const subscription = event.data;
        const userId = subscription.custom_data?.user_id;
        const plan = subscription.custom_data?.plan;

        if (!userId) break;

        const periodEnd = new Date(subscription.current_billing_period.ends_at);

        await query(
          `UPDATE subscriptions SET
             plan = $1, status = $2, current_period_end = $3
           WHERE user_id = $4`,
          [plan, subscription.status, periodEnd, userId]
        );

        await query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);

        console.log(`🔄 Subscription updated: user ${userId} → ${plan}`);
        break;
      }

      // ── Subscription cancelled ────────────────────────────────────────────
      case 'subscription.canceled': {
        const subscription = event.data;
        const userId = subscription.custom_data?.user_id;

        if (!userId) break;

        await query(
          `UPDATE subscriptions SET status = 'cancelled', plan = 'free' WHERE user_id = $1`,
          [userId]
        );
        await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);

        console.log(`❌ Subscription cancelled: user ${userId} → free`);
        break;
      }

      // ── Payment failed ────────────────────────────────────────────────────
      case 'transaction.payment_failed': {
        const transaction = event.data;
        const userId = transaction.custom_data?.user_id;

        if (!userId) break;

        await query(
          `UPDATE subscriptions SET status = 'past_due' WHERE user_id = $1`,
          [userId]
        );

        console.log(`⚠️ Payment failed: user ${userId}`);
        break;
      }

      default:
        // Unhandled event type
        break;
    }
  } catch (err) {
    console.error(`Webhook handler error for ${eventType}:`, err);
  }

  res.json({ received: true });
});

// ─── Verify Paddle Webhook Signature ─────────────────────────────────────────
function verifyPaddleWebhook(body, signature) {
  if (!signature || !PADDLE_WEBHOOK_SECRET) return false;

  // Paddle signature format: "ts=timestamp;h1=hash"
  const parts = signature.split(';').reduce((acc, part) => {
    const [key, value] = part.split('=');
    acc[key] = value;
    return acc;
  }, {});

  const timestamp = parts.ts;
  const hash = parts.h1;

  // Construct the signed payload: timestamp:body
  const signedPayload = `${timestamp}:${body}`;

  // Verify HMAC
  const expectedHash = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

module.exports = router;
