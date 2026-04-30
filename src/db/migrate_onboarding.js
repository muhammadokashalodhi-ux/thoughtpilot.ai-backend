'use strict';

require('dotenv').config();
const { query, pool } = require('./index');

const sql = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS user_headline    VARCHAR(500),
  ADD COLUMN IF NOT EXISTS companies        TEXT,
  ADD COLUMN IF NOT EXISTS countries        TEXT,
  ADD COLUMN IF NOT EXISTS achievements     TEXT,
  ADD COLUMN IF NOT EXISTS cv_raw           TEXT,
  ADD COLUMN IF NOT EXISTS projects         TEXT,
  ADD COLUMN IF NOT EXISTS awards           TEXT,
  ADD COLUMN IF NOT EXISTS style_notes      TEXT,
  ADD COLUMN IF NOT EXISTS post_length      VARCHAR(20) DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS content_pillars  JSONB       DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
`;

async function run() {
  console.log('[Migration] Running onboarding schema update...');
  try {
    await query(sql);
    console.log('[Migration] ✅ Onboarding columns added successfully');
  } catch (err) {
    console.error('[Migration] ❌ Failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
