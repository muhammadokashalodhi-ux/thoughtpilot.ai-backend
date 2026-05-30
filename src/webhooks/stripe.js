'use strict';

/**
 * webhooks/stripe.js — Stripe Webhook Event Handler
 *
 * Events handled:
 *   checkout.session.completed       — payment succeeded, activate subscription
 *   customer.subscription.updated    — upgrade, downgrade, renewal
 *   customer.subscription.deleted    — cancellation took effect, downgrade to free
 *   invoice.payment_failed           — mark as past_due
 *   invoice.payment_succeeded        — renewal confirmed, reset monthly usage
 */

const Stripe         = require('stripe');
const { query }      = require('../db/index');
const { getPlanFromPriceId } = require('../config/limits');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ─── Signature Verification ────────────────────────────────────────────────

function constructEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// ─── DB Helper ─────────────────────────────────────────────────────────────

async function upsertSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  billingInterval,
  plan,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
}) {
  await query(
    `INSERT INTO subscriptions
       (user_id, plan, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, billing_interval, status,
        current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       plan                   = EXCLUDED.plan,
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id        = EXCLUDED.stripe_price_id,
       billing_interval       = EXCLUDED.billing_interval,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       updated_at             = NOW()`,
    [
      userId, plan, stripeCustomerId, stripeSubscriptionId,
      stripePriceId, billingInterval, status,
      currentPeriodEnd, cancelAtPeriodEnd,
    ]
  );

  await query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
}

async function getUserByStripeCustomerId(customerId) {
  const res = await query(
    `SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1`,
    [customerId]
  );
  return res.rows[0]?.user_id || null;
}

async function resetMonthlyUsage(userId) {
  try {
    await query(
      `INSERT INTO usage_tracking (user_id, posts_this_month, billing_month_start)
       VALUES ($1, 0, date_trunc('month', CURRENT_DATE)::DATE)
       ON CONFLICT (user_id) DO UPDATE SET
         posts_this_month    = 0,
         billing_month_start = date_trunc('month', CURRENT_DATE)::DATE`,
      [userId]
    );
  } catch (err) {
    console.error('[Stripe] resetMonthlyUsage failed:', err.message);
  }
}

// ─── Event Handlers ────────────────────────────────────────────────────────

/**
 * checkout.session.completed
 * First payment succeeded — activate the subscription.
 */
async function handleCheckoutCompleted(session) {
  const userId = session.metadata?.user_id;
  if (!userId) {
    console.warn('[Stripe] checkout.session.completed — no user_id in metadata');
    return;
  }

  const subscriptionId = session.subscription;
  if (!subscriptionId) return;

  // Fetch full subscription from Stripe for price + period details
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId      = subscription.items.data[0]?.price?.id;
  const plan         = getPlanFromPriceId(priceId);
  const interval     = session.metadata?.billing_interval || 'monthly';
  const periodEnd    = new Date(subscription.current_period_end * 1000);

  await upsertSubscription({
    userId,
    stripeCustomerId:     session.customer,
    stripeSubscriptionId: subscriptionId,
    stripePriceId:        priceId,
    billingInterval:      interval,
    plan,
    status:               'active',
    currentPeriodEnd:     periodEnd,
    cancelAtPeriodEnd:    false,
  });

  await resetMonthlyUsage(userId);

  console.log(`[Stripe] ✅ checkout.session.completed → user:${userId} plan:${plan}`);
}

/**
 * customer.subscription.updated
 * Upgrade, downgrade, renewal update, or cancel scheduled.
 */
async function handleSubscriptionUpdated(subscription) {
  const userId = subscription.metadata?.user_id
    || await getUserByStripeCustomerId(subscription.customer);

  if (!userId) {
    console.warn('[Stripe] subscription.updated — unknown customer:', subscription.customer);
    return;
  }

  const priceId  = subscription.items.data[0]?.price?.id;
  const status   = subscription.status;
  const plan     = (status === 'canceled' || status === 'unpaid')
    ? 'free'
    : getPlanFromPriceId(priceId);

  const periodEnd        = new Date(subscription.current_period_end * 1000);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end || false;

  // Determine billing interval from Stripe price interval
  const stripeInterval = subscription.items.data[0]?.price?.recurring?.interval;
  const billingInterval = stripeInterval === 'year' ? 'annual' : 'monthly';

  await upsertSubscription({
    userId,
    stripeCustomerId:     subscription.customer,
    stripeSubscriptionId: subscription.id,
    stripePriceId:        priceId,
    billingInterval,
    plan,
    status:               cancelAtPeriodEnd ? 'canceling' : status,
    currentPeriodEnd:     periodEnd,
    cancelAtPeriodEnd,
  });

  console.log(`[Stripe] 🔄 subscription.updated → user:${userId} plan:${plan} status:${status}`);
}

/**
 * customer.subscription.deleted
 * Cancellation took effect — downgrade to free immediately.
 */
async function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata?.user_id
    || await getUserByStripeCustomerId(subscription.customer);

  if (!userId) return;

  await query(
    `UPDATE subscriptions
     SET plan = 'free', status = 'canceled', cancel_at_period_end = false
     WHERE user_id = $1`,
    [userId]
  );
  await query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);

  console.log(`[Stripe] ❌ subscription.deleted → user:${userId} → downgraded to free`);
}

/**
 * invoice.payment_succeeded
 * Renewal payment confirmed — reset monthly usage counter.
 */
async function handleInvoicePaymentSucceeded(invoice) {
  if (invoice.billing_reason !== 'subscription_cycle') return;

  const userId = await getUserByStripeCustomerId(invoice.customer);
  if (!userId) return;

  await resetMonthlyUsage(userId);

  console.log(`[Stripe] 💳 invoice.payment_succeeded (renewal) → user:${userId}`);
}

/**
 * invoice.payment_failed
 * Mark as past_due — Stripe will retry automatically.
 */
async function handleInvoicePaymentFailed(invoice) {
  const userId = await getUserByStripeCustomerId(invoice.customer);
  if (!userId) return;

  await query(
    `UPDATE subscriptions SET status = 'past_due' WHERE user_id = $1`,
    [userId]
  );

  console.log(`[Stripe] ⚠️ invoice.payment_failed → user:${userId}`);
}

// ─── Event Router ──────────────────────────────────────────────────────────

const EVENT_HANDLERS = {
  'checkout.session.completed':      handleCheckoutCompleted,
  'customer.subscription.updated':   handleSubscriptionUpdated,
  'customer.subscription.deleted':   handleSubscriptionDeleted,
  'invoice.payment_succeeded':       handleInvoicePaymentSucceeded,
  'invoice.payment_failed':          handleInvoicePaymentFailed,
};

// ─── Main Entry Point ──────────────────────────────────────────────────────

async function processStripeWebhook(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  }

  let event;
  try {
    event = constructEvent(rawBody, signature);
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  console.log(`[Stripe Webhook] ${event.type} — id:${event.id}`);

  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    await handler(event.data.object);
  } else {
    console.log(`[Stripe] Unhandled event: ${event.type}`);
  }
}

module.exports = { processStripeWebhook };
