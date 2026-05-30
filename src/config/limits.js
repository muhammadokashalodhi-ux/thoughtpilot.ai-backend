'use strict';

/**
 * limits.js — Single source of truth for ThoughtPilot plan limits
 */

const PLAN_RANK = {
  free:    0,
  beta:    1,
  starter: 2,
  pro:     3,
  admin:   99,
};

const PLAN_LIMITS = {
  free: {
    posts_per_month:     3,
    posts_per_day:       1,
    pillars:             1,
    trend_radar:         false,
    cv_analyses_per_day: 1,
    job_matches_per_day: 1,
    calendar_weeks:      0,
    email_notifications: false,
    wa_notifications:    false,
    comment_helper:      false,
    analytics:           false,
  },
  beta: {
    posts_per_month:     999999,
    posts_per_day:       999999,
    pillars:             999999,
    trend_radar:         true,
    cv_analyses_per_day: 999999,
    job_matches_per_day: 999999,
    calendar_weeks:      999999,
    email_notifications: true,
    wa_notifications:    true,
    comment_helper:      true,
    analytics:           true,
  },
  starter: {
    posts_per_month:     30,
    posts_per_day:       2,
    pillars:             5,
    trend_radar:         true,
    cv_analyses_per_day: 10,
    job_matches_per_day: 20,
    calendar_weeks:      4,
    email_notifications: true,
    wa_notifications:    false,
    comment_helper:      true,
    analytics:           false,
  },
  pro: {
    posts_per_month:     999999,
    posts_per_day:       999999,
    pillars:             999999,
    trend_radar:         true,
    cv_analyses_per_day: 999999,
    job_matches_per_day: 999999,
    calendar_weeks:      999999,
    email_notifications: true,
    wa_notifications:    true,
    comment_helper:      true,
    analytics:           true,
  },
  admin: {
    posts_per_month:     999999,
    posts_per_day:       999999,
    pillars:             999999,
    trend_radar:         true,
    cv_analyses_per_day: 999999,
    job_matches_per_day: 999999,
    calendar_weeks:      999999,
    email_notifications: true,
    wa_notifications:    true,
    comment_helper:      true,
    analytics:           true,
  },
};

const PLAN_PRICING = {
  free: {
    name:                 'Free',
    price_monthly:        0,
    price_annual:         0,
    annual_total:         0,
    stripe_price_monthly: null,
    stripe_price_annual:  null,
  },
  starter: {
    name:                 'Starter',
    price_monthly:        19,
    price_annual:         15.20,
    annual_total:         182.40,
    stripe_price_monthly: process.env.STRIPE_STARTER_MONTHLY,
    stripe_price_annual:  process.env.STRIPE_STARTER_ANNUAL,
  },
  pro: {
    name:                 'Pro',
    price_monthly:        49,
    price_annual:         39.20,
    annual_total:         470.40,
    stripe_price_monthly: process.env.STRIPE_PRO_MONTHLY,
    stripe_price_annual:  process.env.STRIPE_PRO_ANNUAL,
  },
};

function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_STARTER_MONTHLY]: 'starter',
    [process.env.STRIPE_STARTER_ANNUAL]:  'starter',
    [process.env.STRIPE_PRO_MONTHLY]:     'pro',
    [process.env.STRIPE_PRO_ANNUAL]:      'pro',
  };
  return map[priceId] || 'free';
}

function getLimitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

function planMeetsRequirement(userPlan, requiredPlan) {
  return (PLAN_RANK[userPlan] ?? 0) >= (PLAN_RANK[requiredPlan] ?? 0);
}

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
