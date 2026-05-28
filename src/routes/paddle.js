'use strict';

/**
 * webhooks/paddle.js — Paddle Webhook Event Handler
 *
 * Called by routes/webhooks.js after signature verification.
 *
 * Events handled:
 *   subscription.activated     — new paid subscription, upgrade user plan
 *   subscription.updated       — plan change, renewal, pause/resume
 *   subscription.canceled      — downgrade to free at period end
 *   subscription.paused        — payment issue, restrict access
 *   transaction.completed      — payment confirmed (also fires on renewal)
 *   transaction.payment_failed — mark as past_due
 */

const crypto             = require('crypto');
const { query }          = require('../db/index');
const { getPlanFromPriceId } = require('../config/limits');

// ─── Signature Verification ────────────────────────────────────────────────
/**
 * Paddle v2 webhook signature format:
 * Paddle-Signature: ts=TIMESTAMP;h1=HMAC_SHA256_HEX
 * Signed payload: `${ts}:${rawBody}`
 */
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = {};
  signatureHeader.split(';').forEach(part => {
    const [key, ...rest] = part.split('=');
    parts[key] = rest.join('='); // handle = in base64 if ever present
  });

  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const expectedHash  = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // Ensure both buffers are same length before timingSafeEqual
  const a = Buffer.from(h1,           'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// ─── DB Helpers ────────────────────────────────────────────────────────────

/**
 * Upsert subscription row and keep users.plan in sync.
 * All Paddle column names use the migrated names (paddle_*, not stripe_*).
 */
async function upsertSubscription({
  userId,
  paddleCustomerId,
  paddleSubscriptionId,
  paddlePriceId,
  billingInterval,
  plan,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
}) {
  await query(
    `INSERT INTO subscriptions
       (user_id, plan, paddle_customer_id, paddle_subscription_id,
        paddle_price_id, billing_interval, status,
        current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       plan                   = EXCLUDED.plan,
       paddle_customer_id     = EXCLUDED.paddle_customer_id,
       paddle_subscription_id = EXCLUDED.paddle_subscription_id,
       paddle_price_id        = EXCLUDED.paddle_price_id,
       billing_interval       = EXCLUDED.billing_interval,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       updated_at             = NOW()`,
    [
      userId, plan, paddleCustomerId, paddleSubscriptionId,
      paddlePriceId, billingInterval, status,
      currentPeriodEnd, cancelAtPeriodEnd,
    ]
  );

  // Keep users.plan in sync — fast middleware checks read from here
  await query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
}

/**
 * Resolve billing_interval from Paddle price billing_cycle object
 * billing_cycle: { interval: 'month'|'year', frequency: 1 }
 */
function resolveBillingInterval(priceObj) {
  const interval = priceObj?.billing_cycle?.interval;
  if (interval === 'year')  return 'annual';
  if (interval === 'month') return 'monthly';
  return null;
}

/**
 * Look up our user_id from paddle_customer_id
 */
async function getUserByPaddleCustomerId(customerId) {
  const res = await query(
    `SELECT user_id FROM subscriptions WHERE paddle_customer_id = $1`,
    [customerId]
  );
  return res.rows[0]?.user_id || null;
}

/**
 * Reset monthly post counter when a new billing period starts.
 * Called on subscription.activated and transaction.completed (renewals).
 */
async function resetMonthlyUsage(userId, newPeriodStart) {
  try {
    await query(
      `INSERT INTO usage_tracking (user_id, posts_this_month, billing_month_start)
       VALUES ($1, 0, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         posts_this_month    = 0,
         billing_month_start = $2`,
      [userId, newPeriodStart || new Date()]
    );
  } catch (err) {
    // Never fail the webhook over a usage reset error
    console.error('[Paddle] resetMonthlyUsage failed:', err.message);
  }
}

// ─── Event Handlers ────────────────────────────────────────────────────────

/**
 * subscription.activated
 * Fires when a new subscription is created and first payment succeeds.
 */
async function handleSubscriptionActivated(data) {
  const {
    id:                    subId,
    customer_id:           customerId,
    items,
    current_billing_period,
    custom_data,
    status,
  } = data;

  // user_id must be in custom_data — set during checkout in billing.js
  const userId = custom_data?.user_id;
  if (!userId) {
    console.warn('[Paddle] subscription.activated — no user_id in custom_data, sub:', subId);
    return;
  }

  const priceObj      = items?.[0]?.price;
  const priceId       = priceObj?.id;
  const plan          = getPlanFromPriceId(priceId);
  const billingInterval = resolveBillingInterval(priceObj);
  const periodEnd     = current_billing_period?.ends_at
    ? new Date(current_billing_period.ends_at) : null;
  const periodStart   = current_billing_period?.starts_at
    ? new Date(current_billing_period.starts_at) : new Date();

  await upsertSubscription({
    userId,
    paddleCustomerId:     customerId,
    paddleSubscriptionId: subId,
    paddlePriceId:        priceId,
    billingInterval,
    plan,
    status:               'active',
    currentPeriodEnd:     periodEnd,
    cancelAtPeriodEnd:    false,
  });

  await resetMonthlyUsage(userId, periodStart);

  console.log(`[Paddle] ✅ subscription.activated → user:${userId} plan:${plan} interval:${billingInterval}`);
}

/**
 * subscription.updated
 * Fires on upgrade, downgrade, pause, resume, or renewal update.
 */
async function handleSubscriptionUpdated(data) {
  const {
    id:                    subId,
    customer_id:           customerId,
    items,
    current_billing_period,
    status,
    scheduled_change,
  } = data;

  // Try custom_data first, fall back to customer lookup
  const userId = data.custom_data?.user_id
    || await getUserByPaddleCustomerId(customerId);

  if (!userId) {
    console.warn('[Paddle] subscription.updated — unknown customer:', customerId);
    return;
  }

  const priceObj      = items?.[0]?.price;
  const priceId       = priceObj?.id;
  const billingInterval = resolveBillingInterval(priceObj);

  // If paused or canceled, downgrade to free
  const plan = (status === 'canceled' || status === 'paused')
    ? 'free'
    : getPlanFromPriceId(priceId);

  const periodEnd = current_billing_period?.ends_at
    ? new Date(current_billing_period.ends_at) : null;

  // cancel_at_period_end is true if there's a scheduled cancellation
  const cancelAtPeriodEnd = scheduled_change?.action === 'cancel';

  await upsertSubscription({
    userId,
    paddleCustomerId:     customerId,
    paddleSubscriptionId: subId,
    paddlePriceId:        priceId,
    billingInterval,
    plan,
    status,
    currentPeriodEnd:     periodEnd,
    cancelAtPeriodEnd,
  });

  console.log(`[Paddle] 🔄 subscription.updated → user:${userId} plan:${plan} status:${status}`);
}

/**
 * subscription.canceled
 * Fires when cancellation takes effect (not when scheduled).
 * Downgrade user to free immediately.
 */
async function handleSubscriptionCanceled(data) {
  const { id: subId, customer_id: customerId } = data;

  const userId = data.custom_data?.user_id
    || await getUserByPaddleCustomerId(customerId);

  if (!userId) {
    console.warn('[Paddle] subscription.canceled — unknown customer:', customerId);
    return;
  }

  await query(
    `UPDATE subscriptions
     SET plan = 'free', status = 'canceled', cancel_at_period_end = false
     WHERE user_id = $1`,
    [userId]
  );
  await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);

  console.log(`[Paddle] ❌ subscription.canceled → user:${userId} → downgraded to free`);
}

/**
 * subscription.paused
 * Payment failed repeatedly — restrict access.
 */
async function handleSubscriptionPaused(data) {
  const { customer_id: customerId } = data;

  const userId = data.custom_data?.user_id
    || await getUserByPaddleCustomerId(customerId);

  if (!userId) return;

  await query(
    `UPDATE subscriptions SET status = 'paused' WHERE user_id = $1`,
    [userId]
  );
  await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);

  console.log(`[Paddle] ⏸ subscription.paused → user:${userId}`);
}

/**
 * transaction.completed
 * Fires on every successful payment including renewals.
 * On renewal, reset monthly usage counter.
 */
async function handleTransactionCompleted(data) {
  const { subscription_id: subId, customer_id: customerId, billing_period } = data;

  if (!subId) {
    // One-off transaction, not a subscription — nothing to do
    return;
  }

  const userId = data.custom_data?.user_id
    || await getUserByPaddleCustomerId(customerId);

  if (!userId) return;

  // Reset monthly usage on renewal
  const periodStart = billing_period?.starts_at
    ? new Date(billing_period.starts_at) : new Date();

  await resetMonthlyUsage(userId, periodStart);

  console.log(`[Paddle] 💳 transaction.completed → user:${userId} sub:${subId}`);
}

/**
 * transaction.payment_failed
 * Mark subscription as past_due — keep plan for now (Paddle will retry).
 */
async function handleTransactionPaymentFailed(data) {
  const { subscription_id: subId, customer_id: customerId } = data;

  if (!subId) return;

  const userId = data.custom_data?.user_id
    || await getUserByPaddleCustomerId(customerId);

  if (!userId) {
    // Fallback: update by subscription ID
    await query(
      `UPDATE subscriptions SET status = 'past_due'
       WHERE paddle_subscription_id = $1`,
      [subId]
    );
    return;
  }

  await query(
    `UPDATE subscriptions SET status = 'past_due' WHERE user_id = $1`,
    [userId]
  );

  console.log(`[Paddle] ⚠️ transaction.payment_failed → user:${userId}`);
}

// ─── Event Router ──────────────────────────────────────────────────────────

const EVENT_HANDLERS = {
  'subscription.activated':     handleSubscriptionActivated,
  'subscription.updated':       handleSubscriptionUpdated,
  'subscription.canceled':      handleSubscriptionCanceled,
  'subscription.paused':        handleSubscriptionPaused,
  'transaction.completed':      handleTransactionCompleted,
  'transaction.payment_failed': handleTransactionPaymentFailed,
};

// ─── Main Entry Point ──────────────────────────────────────────────────────

async function processPaddleWebhook(rawBody, signatureHeader) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('PADDLE_WEBHOOK_SECRET is not set');
  }

  if (!verifyPaddleSignature(rawBody, signatureHeader, secret)) {
    throw new Error('Invalid Paddle webhook signature');
  }

  const payload   = JSON.parse(rawBody);
  const eventType = payload.event_type;
  const data      = payload.data;

  console.log(`[Paddle Webhook] ${eventType} — id:${payload.notification_id || 'n/a'}`);

  const handler = EVENT_HANDLERS[eventType];
  if (handler) {
    await handler(data);
  } else {
    console.log(`[Paddle] Unhandled event: ${eventType}`);
  }
}

module.exports = { processPaddleWebhook, verifyPaddleSignature };
