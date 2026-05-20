/**
 * Paddle Billing Routes
 *
 * GET  /api/billing/subscription   — current user's subscription + plan
 * POST /api/billing/checkout       — create a Paddle checkout session URL
 * POST /api/billing/portal         — generate Paddle customer portal URL
 * POST /api/billing/cancel         — cancel subscription at period end
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const { requireAuth } = require('../middleware/auth');

// ─── Paddle API Helper ─────────────────────────────────────────────────────

async function paddleRequest(method, path, body) {
  const baseUrl = process.env.PADDLE_ENV === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('[Paddle API Error]', path, data);
    throw new Error(data?.error?.detail || 'Paddle API error');
  }

  return data;
}

// ─── Plan Config (single source of truth) ─────────────────────────────────

const PLANS = {
  free: {
    name: 'Free',
    price_monthly: 0,
    price_annual: 0,
    limits: {
      posts_per_month: 4,
      pillars: 6,
      trend_refreshes_per_week: 1,
      cv_analyses_per_day: 1,
      job_matches_per_day: 1,
    },
  },
  starter: {
    name: 'Starter',
    price_monthly: 0, // free during beta
    price_annual: 0,
    paddle_price_monthly: process.env.PADDLE_PRICE_STARTER_MONTHLY,
    paddle_price_annual:  process.env.PADDLE_PRICE_STARTER_ANNUAL,
    limits: {
      posts_per_month: 30,
      posts_per_day: 1,
      pillars: 8,
      trend_refreshes: 'daily',
      calendar_weeks: 3,
      notifications: true,
      cv_analyses_per_day: 10,
    },
  },
  pro: {
    name: 'Pro',
    price_monthly: 19,
    price_annual: 13, // 30% off
    paddle_price_monthly: process.env.PADDLE_PRICE_PRO_MONTHLY,
    paddle_price_annual:  process.env.PADDLE_PRICE_PRO_ANNUAL,
    limits: {
      posts_per_month: Infinity,
      pillars: Infinity,
      trend_refreshes: 'unlimited',
      cv_analyses_per_day: Infinity,
    },
  },
  dfy: {
    name: 'Done For You',
    price_monthly: 49,
    price_annual: 34,
    paddle_price_monthly: process.env.PADDLE_PRICE_DFY_MONTHLY,
    paddle_price_annual:  process.env.PADDLE_PRICE_DFY_ANNUAL,
    limits: {
      posts_per_month: Infinity,
      pillars: Infinity,
      managed: true,
    },
  },
};

// ─── GET /api/billing/subscription ────────────────────────────────────────

router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const subResult = await query(
      `SELECT s.*, u.plan, u.email, u.full_name
       FROM subscriptions s
       RIGHT JOIN users u ON u.id = s.user_id
       WHERE u.id = $1`,
      [userId]
    );

    const row = subResult.rows[0];
    const plan = row?.plan || 'free';
    const planConfig = PLANS[plan] || PLANS.free;

    res.json({
      plan,
      plan_name:           planConfig.name,
      limits:              planConfig.limits,
      status:              row?.status || 'none',
      current_period_end:  row?.current_period_end || null,
      paddle_subscription_id: row?.stripe_subscription_id || null,
      paddle_customer_id:     row?.stripe_customer_id || null,
    });
  } catch (err) {
    console.error('GET /billing/subscription', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── POST /api/billing/checkout ───────────────────────────────────────────

/**
 * Body: { price_id: string, billing_cycle: 'monthly'|'annual' }
 *
 * Paddle Billing uses client-side overlay checkout OR redirect.
 * We return a checkout URL that the frontend opens.
 *
 * IMPORTANT: We pass user_id in custom_data so our webhook can link
 * the subscription back to the correct user without email lookup.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { price_id, billing_cycle = 'monthly' } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

    if (!price_id) {
      return res.status(400).json({ error: 'price_id is required' });
    }

    // Create or retrieve Paddle customer
    let customerId = null;
    const subCheck = await query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId]
    );
    customerId = subCheck.rows[0]?.stripe_customer_id || null;

    if (!customerId) {
      // Create new Paddle customer
      const customerData = await paddleRequest('POST', '/customers', {
        email: userEmail,
        custom_data: { user_id: userId },
      });
      customerId = customerData.data?.id;
    }

    // Create Paddle transaction (checkout)
    const txData = await paddleRequest('POST', '/transactions', {
      items: [{ price_id, quantity: 1 }],
      customer_id: customerId,
      custom_data: { user_id: userId },
      checkout: {
        url: `${process.env.FRONTEND_URL}/billing?success=true`,
      },
      // Success and cancel URLs handled via Paddle's checkout settings or passed here
    });

    const checkoutUrl = txData.data?.checkout?.url;

    if (!checkoutUrl) {
      throw new Error('No checkout URL returned from Paddle');
    }

    res.json({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('POST /billing/checkout', err);
    res.status(500).json({ error: err.message || 'Failed to create checkout' });
  }
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────

/**
 * Returns a Paddle customer portal URL so users can manage their subscription
 * (update card, view invoices, cancel, etc.)
 */
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const subResult = await query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId]
    );
    const customerId = subResult.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Generate a portal session for this customer
    const portalData = await paddleRequest(
      'GET',
      `/customers/${customerId}/portal-sessions`
    );

    const portalUrl = portalData.data?.urls?.customer_portal;

    if (!portalUrl) {
      throw new Error('No portal URL returned from Paddle');
    }

    res.json({ portal_url: portalUrl });
  } catch (err) {
    console.error('POST /billing/portal', err);
    res.status(500).json({ error: 'Failed to generate portal link' });
  }
});

// ─── POST /api/billing/cancel ─────────────────────────────────────────────

/**
 * Cancels subscription at end of current billing period
 * (does NOT immediately revoke access)
 */
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const subResult = await query(
      `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    const subscriptionId = subResult.rows[0]?.stripe_subscription_id;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await paddleRequest('POST', `/subscriptions/${subscriptionId}/cancel`, {
      effective_from: 'next_billing_period',
    });

    await query(
      `UPDATE subscriptions SET status = 'canceling' WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true, message: 'Subscription will cancel at end of billing period' });
  } catch (err) {
    console.error('POST /billing/cancel', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── GET /api/billing/plans ───────────────────────────────────────────────

router.get('/plans', async (req, res) => {
  // Public endpoint — returns plan configs with Paddle price IDs for frontend checkout
  res.json({
    plans: Object.entries(PLANS).map(([key, plan]) => ({
      key,
      name: plan.name,
      price_monthly: plan.price_monthly,
      price_annual: plan.price_annual,
      paddle_price_monthly: plan.paddle_price_monthly || null,
      paddle_price_annual:  plan.paddle_price_annual  || null,
      limits: plan.limits,
    })),
  });
});

module.exports = router;
module.exports.PLANS = PLANS;
