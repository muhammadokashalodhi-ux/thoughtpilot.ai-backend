/**
 * Paddle Webhook Handler
 * Handles all Paddle billing events and keeps our DB in sync
 * 
 * Paddle sends webhooks for: subscription created/updated/cancelled/paused,
 * payment succeeded/failed, trial events, etc.
 * 
 * Verify signature using Paddle's public key (PADDLE_WEBHOOK_SECRET env var)
 */

const crypto = require('crypto');
const { query } = require('../db/index');

// ─── Signature Verification ────────────────────────────────────────────────

/**
 * Paddle v2 webhook signature verification
 * Header: Paddle-Signature: ts=TIMESTAMP;h1=HMAC_HASH
 */
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(';').map(part => part.split('='))
  );
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  // Paddle signs: timestamp + ":" + raw body
  const signedPayload = `${ts}:${rawBody}`;
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(h1, 'hex'),
    Buffer.from(expectedHash, 'hex')
  );
}

// ─── Plan Mapping ──────────────────────────────────────────────────────────

/**
 * Map Paddle Price IDs → our internal plan names
 * Set these in your Railway env vars after creating products in Paddle dashboard
 *
 * PADDLE_PRICE_STARTER_MONTHLY  → starter
 * PADDLE_PRICE_STARTER_ANNUAL   → starter
 * PADDLE_PRICE_PRO_MONTHLY      → pro
 * PADDLE_PRICE_PRO_ANNUAL       → pro
 * PADDLE_PRICE_DFY_MONTHLY      → dfy
 * PADDLE_PRICE_DFY_ANNUAL       → dfy
 */
function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.PADDLE_PRICE_STARTER_MONTHLY]: 'starter',
    [process.env.PADDLE_PRICE_STARTER_ANNUAL]:  'starter',
    [process.env.PADDLE_PRICE_PRO_MONTHLY]:      'pro',
    [process.env.PADDLE_PRICE_PRO_ANNUAL]:       'pro',
    [process.env.PADDLE_PRICE_DFY_MONTHLY]:      'dfy',
    [process.env.PADDLE_PRICE_DFY_ANNUAL]:       'dfy',
  };
  return map[priceId] || 'free';
}

// ─── DB Helpers ────────────────────────────────────────────────────────────

async function upsertSubscription({
  userId,
  paddleCustomerId,
  paddleSubscriptionId,
  plan,
  status,
  currentPeriodEnd,
  priceId,
}) {
  await query(
    `INSERT INTO subscriptions
       (id, user_id, plan, stripe_customer_id, stripe_subscription_id,
        status, current_period_end)
     VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id)
     DO UPDATE SET
       plan                   = EXCLUDED.plan,
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end`,
    [userId, plan, paddleCustomerId, paddleSubscriptionId, status, currentPeriodEnd]
  );

  // Keep users.plan in sync for fast middleware checks
  await query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
}

async function getUserByPaddleCustomerId(customerId) {
  const res = await query(
    `SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1`,
    [customerId]
  );
  return res.rows[0]?.user_id || null;
}

async function getUserByEmail(email) {
  const res = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  return res.rows[0]?.id || null;
}

// ─── Event Handlers ────────────────────────────────────────────────────────

async function handleSubscriptionActivated(data) {
  const { id: subId, customer_id, items, current_billing_period, custom_data } = data;

  // Paddle passes our user ID in custom_data.user_id (set during checkout)
  let userId = custom_data?.user_id;

  if (!userId) {
    // Fallback: look up by customer email via Paddle customer object
    console.warn('[Paddle] No user_id in custom_data for subscription:', subId);
    return;
  }

  const priceId = items?.[0]?.price?.id;
  const plan = getPlanFromPriceId(priceId);
  const periodEnd = current_billing_period?.ends_at
    ? new Date(current_billing_period.ends_at)
    : null;

  await upsertSubscription({
    userId,
    paddleCustomerId:     customer_id,
    paddleSubscriptionId: subId,
    plan,
    status:           'active',
    currentPeriodEnd: periodEnd,
    priceId,
  });

  console.log(`[Paddle] Subscription activated → user:${userId} plan:${plan}`);
}

async function handleSubscriptionUpdated(data) {
  const { id: subId, customer_id, items, current_billing_period, status } = data;

  const userId = await getUserByPaddleCustomerId(customer_id);
  if (!userId) {
    console.warn('[Paddle] Unknown customer:', customer_id);
    return;
  }

  const priceId = items?.[0]?.price?.id;
  const plan = status === 'canceled' || status === 'paused'
    ? 'free'
    : getPlanFromPriceId(priceId);

  const periodEnd = current_billing_period?.ends_at
    ? new Date(current_billing_period.ends_at)
    : null;

  await upsertSubscription({
    userId,
    paddleCustomerId:     customer_id,
    paddleSubscriptionId: subId,
    plan,
    status,
    currentPeriodEnd: periodEnd,
    priceId,
  });

  console.log(`[Paddle] Subscription updated → user:${userId} plan:${plan} status:${status}`);
}

async function handleSubscriptionCanceled(data) {
  const { id: subId, customer_id } = data;

  const userId = await getUserByPaddleCustomerId(customer_id);
  if (!userId) return;

  // Downgrade to free, keep subscription record for history
  await query(
    `UPDATE subscriptions SET plan = 'free', status = 'canceled' WHERE user_id = $1`,
    [userId]
  );
  await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);

  console.log(`[Paddle] Subscription canceled → user:${userId} → downgraded to free`);
}

async function handleTransactionCompleted(data) {
  // One-time payment confirmation — useful for DFY plan if sold as one-time
  console.log('[Paddle] Transaction completed:', data.id);
}

async function handleTransactionPaymentFailed(data) {
  const { subscription_id } = data;
  if (!subscription_id) return;

  await query(
    `UPDATE subscriptions SET status = 'past_due' WHERE stripe_subscription_id = $1`,
    [subscription_id]
  );

  console.log('[Paddle] Payment failed for subscription:', subscription_id);
}

// ─── Main Router ───────────────────────────────────────────────────────────

const EVENT_HANDLERS = {
  'subscription.activated':      handleSubscriptionActivated,
  'subscription.updated':        handleSubscriptionUpdated,
  'subscription.canceled':       handleSubscriptionCanceled,
  'transaction.completed':       handleTransactionCompleted,
  'transaction.payment_failed':  handleTransactionPaymentFailed,
};

async function processPaddleWebhook(rawBody, signatureHeader) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!verifyPaddleSignature(rawBody, signatureHeader, secret)) {
    throw new Error('Invalid Paddle webhook signature');
  }

  const payload = JSON.parse(rawBody);
  const eventType = payload.event_type;
  const data = payload.data;

  console.log('[Paddle Webhook]', eventType);

  const handler = EVENT_HANDLERS[eventType];
  if (handler) {
    await handler(data);
  } else {
    console.log('[Paddle] Unhandled event type:', eventType);
  }
}

module.exports = { processPaddleWebhook };
