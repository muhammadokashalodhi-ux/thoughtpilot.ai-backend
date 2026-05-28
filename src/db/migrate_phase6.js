'use strict';

/**
 * Phase 6 Migration — Paddle Billing & Usage Tracking
 *
 * What this does:
 *  1. Renames stripe_customer_id → paddle_customer_id on subscriptions
 *  2. Renames stripe_subscription_id → paddle_subscription_id on subscriptions
 *  3. Adds paddle_price_id, billing_interval, trial_ends_at columns to subscriptions
 *  4. Adds subscriptions updated_at trigger (was missing)
 *  5. Creates usage_tracking table (monthly counters per user)
 *  6. Adds invite_code_used column to users (for beta gate audit trail)
 *  7. Creates indexes for fast usage lookups
 *
 * Safe to run multiple times — all operations use IF EXISTS / IF NOT EXISTS.
 */

require('dotenv').config();
const { query, pool } = require('./index');

const sql = `

-- ─────────────────────────────────────────────────────────────
-- 1. SUBSCRIPTIONS — rename Stripe columns → Paddle
-- ─────────────────────────────────────────────────────────────

ALTER TABLE subscriptions
  RENAME COLUMN stripe_customer_id TO paddle_customer_id;

ALTER TABLE subscriptions
  RENAME COLUMN stripe_subscription_id TO paddle_subscription_id;

-- Add new Paddle-specific columns
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS paddle_price_id       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS billing_interval      VARCHAR(20)
    CHECK (billing_interval IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS trial_ends_at         TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────
-- 2. SUBSCRIPTIONS — add updated_at trigger (was missing)
-- ─────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;

CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- 3. USERS — add invite_code_used for beta gate audit trail
-- ─────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code_used VARCHAR(100);

-- ─────────────────────────────────────────────────────────────
-- 4. USAGE TRACKING TABLE
--    One row per user per billing month.
--    Reset each billing cycle by the webhook handler.
--    All counters default to 0 and are incremented by middleware.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_tracking (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- LinkedIn co-pilot
  posts_this_month      INTEGER NOT NULL DEFAULT 0,
  posts_today           INTEGER NOT NULL DEFAULT 0,
  posts_day_reset_at    DATE    NOT NULL DEFAULT CURRENT_DATE,

  -- Content pillars (point-in-time count, not a monthly counter)
  -- tracked live via COUNT(*) on pillars table, not stored here

  -- Trend radar
  trend_refreshes_this_week    INTEGER NOT NULL DEFAULT 0,
  trend_week_reset_at          DATE    NOT NULL DEFAULT date_trunc('week', CURRENT_DATE)::DATE,

  -- Career Suite
  cv_analyses_today     INTEGER NOT NULL DEFAULT 0,
  cv_day_reset_at       DATE    NOT NULL DEFAULT CURRENT_DATE,

  job_matches_today     INTEGER NOT NULL DEFAULT 0,
  job_day_reset_at      DATE    NOT NULL DEFAULT CURRENT_DATE,

  -- Billing cycle tracking
  billing_month_start   DATE    NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::DATE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 5. USAGE TRACKING — updated_at trigger
-- ─────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS update_usage_tracking_updated_at ON usage_tracking;

CREATE TRIGGER update_usage_tracking_updated_at
  BEFORE UPDATE ON usage_tracking
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- 6. INDEXES
-- ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_usage_tracking_user_id
  ON usage_tracking(user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_customer
  ON subscriptions(paddle_customer_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_subscription
  ON subscriptions(paddle_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions(status);

`;

async function migrate() {
  console.log('[Phase 6 Migration] Starting...');

  // Check if rename already happened (idempotency guard)
  // If paddle_customer_id already exists, skip the rename steps
  const colCheck = await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'subscriptions'
      AND column_name = 'paddle_customer_id'
  `);

  let sqlToRun = sql;

  if (colCheck.rows.length > 0) {
    console.log('[Phase 6 Migration] Columns already renamed — skipping RENAME steps');
    // Strip out the RENAME lines so re-runs don't error
    sqlToRun = sql
      .replace(/ALTER TABLE subscriptions\s+RENAME COLUMN stripe_customer_id TO paddle_customer_id;/g, '')
      .replace(/ALTER TABLE subscriptions\s+RENAME COLUMN stripe_subscription_id TO paddle_subscription_id;/g, '');
  } else {
    // Also check if stripe columns even exist (fresh DB might not have them)
    const stripeCheck = await query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'subscriptions'
        AND column_name = 'stripe_customer_id'
    `);
    if (stripeCheck.rows.length === 0) {
      console.log('[Phase 6 Migration] stripe columns not found — adding paddle columns directly');
      sqlToRun = sql
        .replace(/ALTER TABLE subscriptions\s+RENAME COLUMN stripe_customer_id TO paddle_customer_id;/g,
          `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paddle_customer_id VARCHAR(255);`)
        .replace(/ALTER TABLE subscriptions\s+RENAME COLUMN stripe_subscription_id TO paddle_subscription_id;/g,
          `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paddle_subscription_id VARCHAR(255);`);
    }
  }

  try {
    await query(sqlToRun);
    console.log('[Phase 6 Migration] ✅ Complete');
    console.log('  → subscriptions: paddle_customer_id, paddle_subscription_id, paddle_price_id, billing_interval');
    console.log('  → users: invite_code_used');
    console.log('  → usage_tracking table created');
    console.log('  → indexes created');
  } catch (err) {
    console.error('[Phase 6 Migration] ❌ Failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
