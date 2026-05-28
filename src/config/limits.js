'use strict';

/**
 * limits.js — Single source of truth for ThoughtPilot plan limits
 *
 * THIS IS THE ONLY PLACE plan limits and prices are defined.
 * Do not define limits in routes/billing.js, middleware/plan.js, or anywhere else.
 *
 * Used by:
 *   - middleware/plan.js   (checkLimit, requirePlan)
 *   - routes/billing.js   (GET /billing/plans, GET /billing/subscription)
 *   - routes/auth.js      (signup — plan assignment)
 *   - webhooks/paddle.js  (subscription sync)
 *
 * Paddle Price IDs come from env vars — never hardcoded here.
 */

// ─── Plan Hierarchy ────────────────────────────────────────────────────────
// Used for requirePlan() comparisons
const PLAN_RANK = {
  free:    0,
  beta:    1,   // beta = full access during early access period
  starter: 2,
  pro:     3,
  admin:   99,
};

// ─── Plan Limits ──────────────────────────────────────────────────────────
const PLAN_LIMITS = {

  free: {
    // LinkedIn co-pilot
    posts_per_month:          3,
    posts_per_day:            1,
    pillars:                  1,
    trend_radar:              false,
    // Career Suite
    cv_analyses_per_day:      1,
    job_matches_per_day:      1,
    // Calendar
    calendar_weeks:           0,
    // Notifications
    email_notifications:      false,
    wa_notifications:         false,
    // Comment helper
    comment_helper:           false,
    // Analytics
    analytics:                false,
  },

  beta: {
    // Beta users get Pro-equivalent access during early access
    posts_per_month:          999999,
    posts_per_day:            999999,
    pillars:                  999999,
    trend_radar:              true,
    cv_analyses_per_day:      999999,
    job_matches_per_day:      999999,
    calendar_weeks:           999999,
    email_notifications:      true,
    wa_notifications:         true,
    comment_helper:           true,
    analytics:                true,
  },

  starter: {
    posts_per_month:          30,
    posts_per_day:            2,
    pillars:                  5,
    trend_radar:              true,
    cv_analyses_per_day:      10,
    job_matches_per_day:      20,
    calendar_weeks:           4,
    email_notifications:      true,
    wa_notifications:         false,
    comment_helper:           true,
    analytics:                false,
  },

  pro: {
    posts_per_month:          999999,
    posts_per_day:            999999,
    pillars:                  999999,
    trend_radar:              true,
    cv_analyses_per_day:      999999,
    job_matches_per_day:      999999,
    calendar_weeks:           999999,
    email_notifications:      true,
    wa_notifications:         true,
    comment_helper:           true,
    analytics:                true,
  },

  admin: {
    posts_per_month:          999999,
    posts_per_day:            999999,
    pillars:                  999999,
    trend_radar:              true,
    cv_analyses_per_day:      999999,
    job_matches_per_day:      999999,
    calendar_weeks:           999999,
    email_notifications:      true,
    wa_notifications:         true,
    comment_helper:           true,
    analytics:                true,
  },

};

// ─── Plan Pricing ─────────────────────────────────────────────────────────
const PLAN_PRICING = {
  free: {
    name:           'Free',
    price_monthly:  0,
    price_annual:   0,
    annual_total:   0,
    paddle_price_monthly: null,
    paddle_price_annual:  null,
  },
  starter: {
    name:           'Starter',
    price_monthly:  19,
    price_annual:   15.20,   // per month when billed annually
    annual_total:   182.40,
    paddle_price_monthly: process.env.VITE_PADDLE_STARTER_MONTHLY || process.env.PADDLE_PRICE_STARTER_MONTHLY,
    paddle_price_annual:  process.env.VITE_PADDLE_STARTER_ANNUAL  || process.env.PADDLE_PRICE_STARTER_ANNUAL,
  },
  pro: {
    name:           'Pro',
    price_monthly:  49,
    price_annual:   39.20,   // per month when billed annually
    annual_total:   470.40,
    paddle_price_monthly: process.env.VITE_PADDLE_PRO_MONTHLY || process.env.PADDLE_PRICE_PRO_MONTHLY,
    paddle_price_annual:  process.env.VITE_PADDLE_PRO_ANNUAL  || process.env.PADDLE_PRICE_PRO_ANNUAL,
  },
};

// ─── Price ID → Plan Name Map ──────────────────────────────────────────────
// Used by webhook handler to resolve plan from Paddle price_id
function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.VITE_PADDLE_STARTER_MONTHLY || process.env.PADDLE_PRICE_STARTER_MONTHLY]: 'starter',
    [process.env.VITE_PADDLE_STARTER_ANNUAL  || process.env.PADDLE_PRICE_STARTER_ANNUAL]:  'starter',
    [process.env.VITE_PADDLE_PRO_MONTHLY     || process.env.PADDLE_PRICE_PRO_MONTHLY]:     'pro',
    [process.env.VITE_PADDLE_PRO_ANNUAL      || process.env.PADDLE_PRICE_PRO_ANNUAL]:      'pro',
  };
  return map[priceId] || 'free';
}

// ─── Helper: get limits for a plan ────────────────────────────────────────
function getLimitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

// ─── Helper: check if a plan meets minimum requirement ────────────────────
function planMeetsRequirement(userPlan, requiredPlan) {
  const userRank     = PLAN_RANK[userPlan]     ?? 0;
  const requiredRank = PLAN_RANK[requiredPlan] ?? 0;
  return userRank >= requiredRank;
}

// ─── Helper: get public plans list (for /billing/plans endpoint) ──────────
function getPublicPlans() {
  return ['free', 'starter', 'pro'].map(key => ({
    key,
    ...PLAN_PRICING[key],
    limits: PLAN_LIMITS[key],
  }));
}

module.exports = {
  PLAN_RANK,
  PLAN_LIMITS,
  PLAN_PRICING,
  getPlanFromPriceId,
  getLimitsForPlan,
  planMeetsRequirement,
  getPublicPlans,
};
