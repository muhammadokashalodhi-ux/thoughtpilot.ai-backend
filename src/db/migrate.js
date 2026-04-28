'use strict';

require('dotenv').config();
const { query, pool } = require('./index');

const schema = `

-- ── EXTENSIONS ──
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ──
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255),
  plan          VARCHAR(50) DEFAULT 'beta',
  is_beta       BOOLEAN DEFAULT FALSE,
  is_admin      BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  last_active   TIMESTAMPTZ DEFAULT NOW()
);

-- ── PROFILES ──
CREATE TABLE IF NOT EXISTS profiles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name             VARCHAR(255),
  location              VARCHAR(255),
  user_role             VARCHAR(255),
  years_experience      INTEGER DEFAULT 0,
  career_highlights     TEXT,
  companies_worked      TEXT[],
  countries_worked      TEXT[],
  credentials           TEXT,
  sectors               TEXT[],
  voice_tone            VARCHAR(100) DEFAULT 'Authentic',
  voice_boldness        INTEGER DEFAULT 5,
  voice_length          VARCHAR(50) DEFAULT 'Medium',
  linkedin_url          VARCHAR(500),
  wa_phone              VARCHAR(50),
  wa_apikey             VARCHAR(100),
  email_notifications   BOOLEAN DEFAULT TRUE,
  wa_notifications      BOOLEAN DEFAULT TRUE,
  post_schedule         VARCHAR(50) DEFAULT '0 5 * * *',
  timezone              VARCHAR(100) DEFAULT 'Asia/Dubai',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── PILLARS ──
CREATE TABLE IF NOT EXISTS pillars (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_name   VARCHAR(255) NOT NULL,
  pillar_icon   VARCHAR(10) DEFAULT '📌',
  description   TEXT,
  prompt        TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  display_order INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── POSTS ──
CREATE TABLE IF NOT EXISTS posts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id     UUID REFERENCES pillars(id) ON DELETE SET NULL,
  type          VARCHAR(50) NOT NULL DEFAULT 'trend',
  topic         VARCHAR(500),
  body          TEXT,
  hashtags      TEXT[],
  status        VARCHAR(50) DEFAULT 'pending',
  source        VARCHAR(100) DEFAULT 'manual',
  sector_context TEXT[],
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  approved_at   TIMESTAMPTZ
);

-- ── CALENDAR ──
CREATE TABLE IF NOT EXISTS calendar (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  day_name        VARCHAR(20) NOT NULL,
  theme           VARCHAR(500),
  topic           TEXT,
  category        VARCHAR(100),
  post_type       VARCHAR(50) DEFAULT 'trend',
  custom_override BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, week_start_date, day_name)
);

-- ── SUBSCRIPTIONS ──
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                    VARCHAR(50) DEFAULT 'beta',
  stripe_customer_id      VARCHAR(255),
  stripe_subscription_id  VARCHAR(255),
  status                  VARCHAR(50) DEFAULT 'active',
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── FEEDBACK (beta) ──
CREATE TABLE IF NOT EXISTS feedback (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number     INTEGER,
  rating          INTEGER CHECK (rating >= 1 AND rating <= 10),
  what_worked     TEXT,
  what_broke      TEXT,
  what_missing    TEXT,
  general_notes   TEXT,
  submitted_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── TRENDS CACHE ──
CREATE TABLE IF NOT EXISTS trends_cache (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sectors     TEXT[],
  trends_data JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 hours'
);

-- ── NOTIFICATIONS LOG ──
CREATE TABLE IF NOT EXISTS notification_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50),
  channel     VARCHAR(50),
  subject     TEXT,
  body        TEXT,
  success     BOOLEAN DEFAULT FALSE,
  error       TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ──
CREATE INDEX IF NOT EXISTS idx_posts_user_id     ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_status      ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created_at  ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pillars_user_id   ON pillars(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_user_id  ON calendar(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_week     ON calendar(user_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id  ON feedback(user_id);

-- ── UPDATED_AT TRIGGER ──
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at    ON users;
DROP TRIGGER IF EXISTS update_profiles_updated_at ON profiles;
DROP TRIGGER IF EXISTS update_pillars_updated_at  ON pillars;
DROP TRIGGER IF EXISTS update_posts_updated_at    ON posts;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pillars_updated_at
  BEFORE UPDATE ON pillars
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

async function migrate() {
  console.log('[Migration] Starting database migration...');
  try {
    await query(schema);
    console.log('[Migration] ✅ All tables created successfully');
  } catch (err) {
    console.error('[Migration] ❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
