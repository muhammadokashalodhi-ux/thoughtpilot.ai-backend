'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, pool } = require('./index');

async function seed() {
  console.log('[Seed] Starting database seed...');

  try {
    // ── Create admin user ──
    const adminEmail    = process.env.ADMIN_EMAIL || 'admin@supplai.app';
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const adminHash     = await bcrypt.hash(adminPassword, 12);

    await query(`
      INSERT INTO users (email, password_hash, full_name, plan, is_admin, is_active, onboarding_complete)
      VALUES ($1, $2, $3, 'admin', TRUE, TRUE, TRUE)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            is_admin = TRUE
    `, [adminEmail, adminHash, 'Admin']);

    const adminRes = await query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
    const adminId  = adminRes.rows[0].id;

    await query(`
      INSERT INTO subscriptions (user_id, plan, status)
      VALUES ($1, 'admin', 'active')
      ON CONFLICT (user_id) DO NOTHING
    `, [adminId]);

    console.log(`[Seed] ✅ Admin user created: ${adminEmail}`);

    // ── Create a beta test user ──
    const betaEmail    = process.env.BETA_TEST_EMAIL || 'beta@supplai.app';
    const betaPassword = process.env.BETA_TEST_PASSWORD || 'BetaTest123!';
    const betaHash     = await bcrypt.hash(betaPassword, 12);

    await query(`
      INSERT INTO users (email, password_hash, full_name, plan, is_beta, is_active, onboarding_complete)
      VALUES ($1, $2, $3, 'beta', TRUE, TRUE, FALSE)
      ON CONFLICT (email) DO NOTHING
    `, [betaEmail, betaHash, 'Beta Tester']);

    const betaRes = await query(`SELECT id FROM users WHERE email = $1`, [betaEmail]);
    const betaId  = betaRes.rows[0].id;

    await query(`
      INSERT INTO subscriptions (user_id, plan, status)
      VALUES ($1, 'beta', 'active')
      ON CONFLICT (user_id) DO NOTHING
    `, [betaId]);

    console.log(`[Seed] ✅ Beta test user created: ${betaEmail}`);
    console.log('[Seed] ✅ Seed complete');

  } catch (err) {
    console.error('[Seed] ❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
