'use strict';

/**
 * routes/billing.js — Stripe Billing Routes
 *
 * GET  /api/billing/plans          — public, returns plan configs + Stripe price IDs
 * GET  /api/billing/subscription   — current user's subscription + limits
 * GET  /api/billing/usage          — current user's usage counters
 * POST /api/billing/checkout       — create Stripe Checkout session
 * POST /api/billing/portal         — generate Stripe customer portal URL
 * POST /api/billing/cancel         — cancel subscription at period end
 */

const express   = require('express');
const router    = express.Router();
const Stripe    = require('stripe');
const { query } = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const {
  getLimitsForPlan,
  getPublicPlans,
  getPlanFromPriceId,
} = require('../config/limits');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ─── GET /api/billing/plans ───────────────────────────────────────────────
// Public — no auth required

router.get('/plans', (req, res) => {
  res.json({ plans: getPublicPlans() });
});

// ─── GET /api/billing/subscription ────────────────────────────────────────

router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         u.plan, u.is_beta,
         s.status, s.current_period_end, s.cancel_at_period_end,
         s.stripe_subscription_id, s.stripe_customer_id,
         s.stripe_price_id, s.billing_interval
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const row  = result.rows[0];
    const plan = row?.plan || 'free';

    res.json({
      plan,
      is_beta:                row?.is_beta               || false,
      status:                 row?.status                || 'none',
      current_period_end:     row?.current_period_end    || null,
      cancel_at_period_end:   row?.cancel_at_period_end  || false,
      billing_interval:       row?.billing_interval      || null,
      stripe_subscription_id: row?.stripe_subscription_id || null,
      stripe_customer_id:     row?.stripe_customer_id    || null,
      limits:                 getLimitsForPlan(plan),
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

    await query(
      `INSERT INTO usage_tracking (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const [usageResult, pillarResult] = await Promise.all([
      query(
        `SELECT posts_this_month, posts_today, trend_refreshes_this_week,
                cv_analyses_today, job_matches_today, billing_month_start,
                COALESCE(comments_today, 0) as comments_today
         FROM usage_tracking WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT COUNT(*) AS cnt FROM pillars WHERE user_id = $1 AND is_active = true`,
        [userId]
      ),
    ]);

    const usage = usageResult.rows[0] || {};

    res.json({
      plan,
      limits,
      usage: {
        posts_this_month:          usage.posts_this_month           || 0,
        posts_today:               usage.posts_today                || 0,
        trend_refreshes_this_week: usage.trend_refreshes_this_week  || 0,
        cv_analyses_today:         usage.cv_analyses_today          || 0,
        job_matches_today:         usage.job_matches_today          || 0,
        pillars:                   parseInt(pillarResult.rows[0]?.cnt || 0, 10),
        billing_month_start:       usage.billing_month_start        || null,
        comments_today:            usage.comments_today             || 0,
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
 * Creates a Stripe Checkout Session and returns the URL.
 * On success Stripe redirects to /dashboard/billing?checkout=success
 * user_id is in metadata so webhook can identify the user.
 */

router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { price_id } = req.body;
    const userId       = req.user.id;
    const userEmail    = req.user.email;

    if (!price_id) {
      return res.status(400).json({ error: 'price_id is required' });
    }

    const resolvedPlan = getPlanFromPriceId(price_id);
    if (resolvedPlan === 'free') {
      return res.status(400).json({ error: 'Invalid price_id' });
    }

    // Get or create Stripe customer
    let customerId = null;
    const subCheck = await query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId]
    );
    customerId = subCheck.rows[0]?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { user_id: userId },
      });
      customerId = customer.id;

      await query(
        `INSERT INTO subscriptions (user_id, plan, status, stripe_customer_id)
         VALUES ($1, 'free', 'none', $2)
         ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2`,
        [userId, customerId]
      );
    }

    const billingInterval =
      price_id === process.env.STRIPE_STARTER_ANNUAL ||
      price_id === process.env.STRIPE_PRO_ANNUAL
        ? 'annual' : 'monthly';

    const session = await stripe.checkout.sessions.create({
      mode:       'subscription',
      customer:   customerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/dashboard/billing?checkout=success&plan=${resolvedPlan}`,
      cancel_url:  `${process.env.FRONTEND_URL}/dashboard/billing?checkout=cancelled`,
      metadata: {
        user_id:          userId,
        plan:             resolvedPlan,
        billing_interval: billingInterval,
      },
      subscription_data: {
        metadata: {
          user_id:          userId,
          plan:             resolvedPlan,
          billing_interval: billingInterval,
        },
      },
      allow_promotion_codes:      true,
      billing_address_collection: 'auto',
    });

    res.json({ checkout_url: session.url });
  } catch (err) {
    console.error('[billing] POST /checkout', err.message);
    res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────

router.post('/portal', requireAuth, async (req, res) => {
  try {
    const subResult = await query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [req.user.id]
    );
    const customerId = subResult.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({
        error: 'No billing account found — please subscribe first',
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    console.error('[billing] POST /portal', err.message);
    res.status(500).json({ error: 'Failed to generate billing portal link' });
  }
});

// ─── POST /api/billing/cancel ─────────────────────────────────────────────

router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const subResult = await query(
      `SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1`,
      [req.user.id]
    );
    const sub = subResult.rows[0];

    if (!sub?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    if (sub.status === 'canceled' || sub.status === 'canceling') {
      return res.status(400).json({ error: 'Subscription is already cancelled' });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await query(
      `UPDATE subscriptions
       SET cancel_at_period_end = true, status = 'canceling'
       WHERE user_id = $1`,
      [req.user.id]
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
