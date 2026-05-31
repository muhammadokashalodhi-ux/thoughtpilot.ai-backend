'use strict';

/**
 * middleware/plan.js — Plan enforcement middleware
 */

const { query } = require('../db/index');
const { getLimitsForPlan, planMeetsRequirement } = require('../config/limits');

// ─── requirePlan ──────────────────────────────────────────────────────────
function requirePlan(minPlan) {
  return (req, res, next) => {
    const userPlan = req.user?.plan || 'free';
    if (req.user?.is_admin) return next();
    if (userPlan === 'beta') return next();
    if (!planMeetsRequirement(userPlan, minPlan)) {
      return res.status(403).json({
        error:       'Plan upgrade required',
        code:        'PLAN_LIMIT',
        required:    minPlan,
        current:     userPlan,
        upgrade_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
      });
    }
    next();
  };
}

// ─── ensureUsageRow ───────────────────────────────────────────────────────
async function ensureUsageRow(userId) {
  await query(
    `INSERT INTO usage_tracking (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

// ─── checkLimit ───────────────────────────────────────────────────────────
function checkLimit(limitKey) {
  return async (req, res, next) => {
    try {
      const userId   = req.user.id;
      const userPlan = req.user.plan || 'free';

      // Admin and beta bypass all limits
      if (req.user?.is_admin || userPlan === 'beta') {
        req.limitInfo = { limitKey, used: 0, limit: 999999, remaining: 999999 };
        return next();
      }

      const limits = getLimitsForPlan(userPlan);
      const limit  = limits[limitKey] ?? 999999;
      let used = 0;

      await ensureUsageRow(userId);

      const today    = new Date().toISOString().slice(0, 10);
      const thisWeek = (() => {
        const d = new Date();
        d.setDate(d.getDate() - d.getDay());
        return d.toISOString().slice(0, 10);
      })();

      switch (limitKey) {

        // ── Posts ────────────────────────────────────────────────────────
        case 'posts_per_month': {
          const r = await query(
            `SELECT posts_this_month, billing_month_start FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          const monthStart = row?.billing_month_start?.toISOString().slice(0, 7);
          const thisMonth  = new Date().toISOString().slice(0, 7);
          if (monthStart !== thisMonth) {
            await query(
              `UPDATE usage_tracking SET posts_this_month = 0, billing_month_start = date_trunc('month', CURRENT_DATE)::DATE WHERE user_id = $1`,
              [userId]
            );
            used = 0;
          } else {
            used = row?.posts_this_month || 0;
          }
          break;
        }

        case 'posts_per_day': {
          const r = await query(
            `SELECT posts_today, posts_day_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.posts_day_reset_at?.toISOString().slice(0, 10) !== today) {
            await query(`UPDATE usage_tracking SET posts_today = 0, posts_day_reset_at = CURRENT_DATE WHERE user_id = $1`, [userId]);
            used = 0;
          } else {
            used = row?.posts_today || 0;
          }
          break;
        }

        // ── Trend radar ──────────────────────────────────────────────────
        case 'trend_refreshes_per_week': {
          const r = await query(
            `SELECT trend_refreshes_this_week, trend_week_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.trend_week_reset_at?.toISOString().slice(0, 10) !== thisWeek) {
            await query(
              `UPDATE usage_tracking SET trend_refreshes_this_week = 0, trend_week_reset_at = date_trunc('week', CURRENT_DATE)::DATE WHERE user_id = $1`,
              [userId]
            );
            used = 0;
          } else {
            used = row?.trend_refreshes_this_week || 0;
          }
          break;
        }

        // ── CV analyses ──────────────────────────────────────────────────
        case 'cv_analyses_per_day': {
          const r = await query(
            `SELECT cv_analyses_today, cv_day_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.cv_day_reset_at?.toISOString().slice(0, 10) !== today) {
            await query(`UPDATE usage_tracking SET cv_analyses_today = 0, cv_day_reset_at = CURRENT_DATE WHERE user_id = $1`, [userId]);
            used = 0;
          } else {
            used = row?.cv_analyses_today || 0;
          }
          break;
        }

        case 'cv_analyses_per_month': {
          const r = await query(
            `SELECT cv_analyses_this_month, cv_month_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          const monthStart = row?.cv_month_reset_at?.toISOString().slice(0, 7);
          const thisMonth  = new Date().toISOString().slice(0, 7);
          if (monthStart !== thisMonth) {
            await query(
              `UPDATE usage_tracking SET cv_analyses_this_month = 0, cv_month_reset_at = date_trunc('month', CURRENT_DATE)::DATE WHERE user_id = $1`,
              [userId]
            );
            used = 0;
          } else {
            used = row?.cv_analyses_this_month || 0;
          }
          break;
        }

        // ── Job matches ──────────────────────────────────────────────────
        case 'job_matches_per_day': {
          const r = await query(
            `SELECT job_matches_today, job_day_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.job_day_reset_at?.toISOString().slice(0, 10) !== today) {
            await query(`UPDATE usage_tracking SET job_matches_today = 0, job_day_reset_at = CURRENT_DATE WHERE user_id = $1`, [userId]);
            used = 0;
          } else {
            used = row?.job_matches_today || 0;
          }
          break;
        }

        case 'job_matches_per_month': {
          const r = await query(
            `SELECT job_matches_this_month, job_month_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          const monthStart = row?.job_month_reset_at?.toISOString().slice(0, 7);
          const thisMonth  = new Date().toISOString().slice(0, 7);
          if (monthStart !== thisMonth) {
            await query(
              `UPDATE usage_tracking SET job_matches_this_month = 0, job_month_reset_at = date_trunc('month', CURRENT_DATE)::DATE WHERE user_id = $1`,
              [userId]
            );
            used = 0;
          } else {
            used = row?.job_matches_this_month || 0;
          }
          break;
        }

        // ── Comments ─────────────────────────────────────────────────────
        case 'comments_per_day': {
          const r = await query(
            `SELECT comments_today, comments_day_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.comments_day_reset_at?.toISOString().slice(0, 10) !== today) {
            await query(`UPDATE usage_tracking SET comments_today = 0, comments_day_reset_at = CURRENT_DATE WHERE user_id = $1`, [userId]);
            used = 0;
          } else {
            used = row?.comments_today || 0;
          }
          break;
        }

        // ── Calendar posts ───────────────────────────────────────────────
        case 'calendar_posts_per_week': {
          const r = await query(
            `SELECT calendar_posts_this_week, calendar_week_reset_at FROM usage_tracking WHERE user_id = $1`,
            [userId]
          );
          const row = r.rows[0];
          if (row?.calendar_week_reset_at?.toISOString().slice(0, 10) !== thisWeek) {
            await query(
              `UPDATE usage_tracking SET calendar_posts_this_week = 0, calendar_week_reset_at = date_trunc('week', CURRENT_DATE)::DATE WHERE user_id = $1`,
              [userId]
            );
            used = 0;
          } else {
            used = row?.calendar_posts_this_week || 0;
          }
          break;
        }

        // ── Pillars (live count) ─────────────────────────────────────────
        case 'pillars': {
          const r = await query(
            `SELECT COUNT(*) AS cnt FROM pillars WHERE user_id = $1 AND is_active = true`,
            [userId]
          );
          used = parseInt(r.rows[0]?.cnt || 0, 10);
          break;
        }

        default:
          console.warn(`[checkLimit] Unknown limitKey: ${limitKey}`);
          req.limitInfo = { limitKey, used: 0, limit: 999999, remaining: 999999 };
          return next();
      }

      if (used >= limit) {
        return res.status(403).json({
          error:       'Usage limit reached',
          code:        'USAGE_LIMIT',
          limit_key:   limitKey,
          used,
          limit,
          plan:        userPlan,
          upgrade_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
        });
      }

      req.limitInfo = { limitKey, used, limit, remaining: limit - used };
      next();
    } catch (err) {
      console.error('[checkLimit] Error:', err.message);
      next(err);
    }
  };
}

// ─── incrementUsage ───────────────────────────────────────────────────────
async function incrementUsage(userId, limitKey) {
  try {
    const colMap = {
      posts_per_month:          'posts_this_month = posts_this_month + 1',
      posts_per_day:            'posts_today = posts_today + 1',
      trend_refreshes_per_week: 'trend_refreshes_this_week = trend_refreshes_this_week + 1',
      cv_analyses_per_day:      'cv_analyses_today = cv_analyses_today + 1',
      cv_analyses_per_month:    'cv_analyses_this_month = cv_analyses_this_month + 1',
      job_matches_per_day:      'job_matches_today = job_matches_today + 1',
      job_matches_per_month:    'job_matches_this_month = job_matches_this_month + 1',
      comments_per_day:         'comments_today = comments_today + 1',
      calendar_posts_per_week:  'calendar_posts_this_week = calendar_posts_this_week + 1',
    };

    const update = colMap[limitKey];
    if (!update) return;

    await query(
      `INSERT INTO usage_tracking (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    await query(`UPDATE usage_tracking SET ${update} WHERE user_id = $1`, [userId]);
  } catch (err) {
    console.error('[incrementUsage] Failed:', err.message);
  }
}

module.exports = { requirePlan, checkLimit, incrementUsage, getLimitsForPlan };
