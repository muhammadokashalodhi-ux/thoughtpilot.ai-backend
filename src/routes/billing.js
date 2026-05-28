'use strict';

/**
 * routes/billing.js — Paddle Billing Routes
 *
 * GET  /api/billing/plans          — public, returns plan configs + price IDs
 * GET  /api/billing/subscription   — current user's subscription + usage
 * GET  /api/billing/usage          — current user's usage counters
 * POST /api/billing/checkout       — create Paddle checkout transaction URL
 * POST /api/billing/portal         — generate Paddle customer portal URL
 * POST /api/billing/cancel         — cancel subscription at period end
 */

const express    = require('express');
const router     = express.Router();
const { query }  = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const {
  getLimitsForPlan,
  getPublicPlans,
  getPlanFromPriceId,
} = require('../config/limits');

// ─── Paddle API Helper ─────────────────────────────────────────────────────

const PADDLE_BASE_URL = process.env.PADDLE_ENV === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

async function paddleRequest(method, path, body) {
  const res = await fetch(`${PADDLE_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('[Paddle API Error]', method, path, data?.error);
    throw new Error(data?.error?.detail || `Paddle API error: ${res.status}`);
  }

  return data;
}

// ─── GET /api/billing/plans ───────────────────────────────────────────────
// Public — no auth required
// Returns plan configs with Paddle price IDs for frontend checkout

router.get('/plans', (req, res) => {
  res.json({ plans: getPublicPlans() });
});

// ─── GET /api/billing/subscription ────────────────────────────────────────

router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `SELECT
         u.plan,
         u.email,
         u.full_name,
         u.is_beta,
         s.status,
         s.current_period_end,
         s.cancel_at_period_end,
         s.paddle_subscription_id,
         s.paddle_customer_id,
         s.paddle_price_id,
         s.billing_interval
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    const row  = result.rows[0];
    const plan = row?.plan || 'free';

    res.json({
      plan,
      is_beta:               row?.is_beta || false,
      status:                row?.status  || 'none',
      current_period_end:    row?.current_period_end    || null,
      cancel_at_period_end:  row?.cancel_at_period_end  || false,
      billing_interval:      row?.billing_interval      || null,
      paddle_subscription_id: row?.paddle_subscription_id || null,
      paddle_customer_id:    row?.paddle_customer_id    || null,
      limits:                getLimitsForPlan(plan),
    });
  } catch (err) {
    console.error('[billing] GET /subscription', err.message);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── GET /api/billing/usage ───────────────────────────────────────────────

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan   = req.user.plan || 'free';
    const limits = getLimitsForPlan(plan);

    // Ensure row exists
    await query(
      `INSERT INTO usage_tracking (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const result = await query(
      `SELECT
         posts_this_month, posts_today,
         trend_refreshes_this_week,
         cv_analyses_today, job_matches_today,
         billing_month_start
       FROM usage_tracking WHERE user_id = $1`,
      [userId]
    );

    // Pillar count is live
    const pillarResult = await query(
      `SELECT COUNT(*) AS cnt FROM pillars WHERE user_id = $1 AND is_active = true`,
      [userId]
    );

    const usage = result.rows[0] || {};
    const pillarsUsed = parseInt(pillarResult.rows[0]?.cnt || 0, 10);

    res.json({
      plan,
      limits,
      usage: {
        posts_this_month:         usage.posts_this_month          || 0,
        posts_today:              usage.posts_today               || 0,
        trend_refreshes_this_week: usage.trend_refreshes_this_week || 0,
        cv_analyses_today:        usage.cv_analyses_today         || 0,
        job_matches_today:        usage.job_matches_today         || 0,
        pillars:                  pillarsUsed,
        billing_month_start:      usage.billing_month_start       || null,
      },
    });
  } catch (err) {
    console.error('[billing] GET /usage', err.message);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// ─── POST /api/billing/checkout ───────────────────────────────────────────
/**
 * Body: { price_id: string }
 *
 * Creates a Paddle transaction and returns the checkout URL.
 * The frontend opens it as an overlay (Paddle.js) or redirect.
 *
 * user_id is passed in custom_data so the webhook can link
 * the subscription to the correct user without email lookup.
 */

router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { price_id } = req.body;
    const userId    = req.user.id;
    const userEmail = req.user.email;

    if (!price_id) {
      return res.status(400).json({ error: 'price_id is required' });
    }

    // Validate price_id is one of our known prices
    const resolvedPlan = getPlanFromPriceId(price_id);
    if (resolvedPlan === 'free') {
      return res.status(400).json({ error: 'Invalid price_id' });
    }

    // Look up existing Paddle customer ID
    const subCheck = await query(
      `SELECT paddle_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId]
    );
    let customerId = subCheck.rows[0]?.paddle_customer_id || null;

    // Create Paddle customer if first checkout
    if (!customerId) {
      const customerData = await paddleRequest('POST', '/customers', {
        email: userEmail,
        custom_data: { user_id: userId },
      });
      customerId = customerData.data?.id;

      if (!customerId) {
        throw new Error('Failed to create Paddle customer');
      }

      // Store customer ID immediately so retries don't create duplicates
      await query(
        `INSERT INTO subscriptions (user_id, plan, status, paddle_customer_id)
         VALUES ($1, 'free', 'none', $2)
         ON CONFLICT (user_id) DO UPDATE SET paddle_customer_id = $2`,
        [userId, customerId]
      );
    }

    // Create Paddle transaction (generates checkout URL)
    const txData = await paddleRequest('POST', '/transactions', {
      items: [{ price_id, quantity: 1 }],
      customer_id: customerId,
      custom_data: { user_id: userId },
      checkout: {
        url: `${process.env.FRONTEND_URL}/dashboard/billing?checkout=success`,
      },
    });

    const checkoutUrl = txData.data?.checkout?.url;
    if (!checkoutUrl) {
      throw new Error('No checkout URL returned from Paddle');
    }

    res.json({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('[billing] POST /checkout', err.message);
    res.status(500).json({ error: err.message || 'Failed to create checkout' });
  }
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────
/**
 * Generates a Paddle customer portal URL.
 * Users can manage payment methods, view invoices, and cancel from here.
 */

router.post('/portal', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const subResult = await query(
      `SELECT paddle_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId]
    );
    const customerId = subResult.rows[0]?.paddle_customer_id;

    if (!customerId) {
      return res.status(400).json({
        error: 'No billing account found — you need an active subscription first',
      });
    }

    // Paddle Billing v2 — create portal session
    const portalData = await paddleRequest(
      'POST',
      `/customers/${customerId}/portal-sessions`,
      {} // empty body required
    );

    const portalUrl = portalData.data?.urls?.general?.overview;

    if (!portalUrl) {
      throw new Error('No portal URL returned from Paddle');
    }

    res.json({ portal_url: portalUrl });
  } catch (err) {
    console.error('[billing] POST /portal', err.message);
    res.status(500).json({ error: 'Failed to generate portal link' });
  }
});

// ─── POST /api/billing/cancel ─────────────────────────────────────────────
/**
 * Cancels subscription at end of current billing period.
 * User keeps access until current_period_end.
 */

router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const subResult = await query(
      `SELECT paddle_subscription_id, status
       FROM subscriptions
       WHERE user_id = $1`,
      [userId]
    );

    const sub = subResult.rows[0];

    if (!sub?.paddle_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    if (sub.status === 'canceled' || sub.status === 'canceling') {
      return res.status(400).json({ error: 'Subscription is already cancelled' });
    }

    await paddleRequest(
      'POST',
      `/subscriptions/${sub.paddle_subscription_id}/cancel`,
      { effective_from: 'next_billing_period' }
    );

    await query(
      `UPDATE subscriptions
       SET status = 'canceling', cancel_at_period_end = true
       WHERE user_id = $1`,
      [userId]
    );

    res.json({
      success: true,
      message: 'Subscription will cancel at end of current billing period',
    });
  } catch (err) {
    console.error('[billing] POST /cancel', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
