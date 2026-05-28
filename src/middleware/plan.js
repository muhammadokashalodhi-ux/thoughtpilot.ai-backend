'use strict';

/**
 * middleware/plan.js — Plan enforcement middleware
 *
 * All limit values come from limits.js — do not define them here.
 *
 * Usage in routes:
 *   const { requirePlan, checkLimit } = require('../middleware/plan');
 *
 *   router.post('/generate', requireAuth, requirePlan('starter'), handler);
 *   router.post('/generate', requireAuth, checkLimit('posts_per_month'), handler);
 */

const { query } = require('../db/index');
const {
  PLAN_LIMITS,
  PLAN_RANK,
  getLimitsForPlan,
  planMeetsRequirement,
} = require('../config/limits');

// ─── requirePlan ──────────────────────────────────────────────────────────
/**
 * Block request if user's plan is below the minimum required.
 * Admin and beta users always pass.
 */
function requirePlan(minPlan) {
  return (req, res, next) => {
    const userPlan = req.user?.plan || 'free';

    if (req.user?.is_admin) return next();
    if (userPlan === 'beta')  return next(); // beta = full access

    if (!planMeetsRequirement(userPlan, minPlan)) {
      return res.status(403).json({
        error:       'Plan upgrade required',
        code:        'PLAN_LIMIT',
        required:    minPlan,
        current:     userPlan,
        upgrade_url: `${process.env.FRONTEND_URL}/pricing`,
      });
    }
    next();
  };
}

// ─── checkLimit ───────────────────────────────────────────────────────────
/**
 * Check a usage limit against usage_tracking table before allowing a request.
 * Attaches req.limitInfo = { limitKey, used, limit, remaining } for handlers.
 *
 * Supported limitKey values:
 *   posts_per_month, posts_per_day,
 *   cv_analyses_per_day, job_matches_per_day,
 *   trend_refreshes_this_week, pillars
 */
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

      // Boolean feature gates (not counters)
      if (limitKey === 'trend_radar') {
        if (!limits.trend_radar) {
          return res.status(403).json({
            error:       'Trend radar requires Starter or Pro plan',
            code:        'FEATURE_GATE',
            limit_key:   limitKey,
            plan:        userPlan,
            upgrade_url: `${process.env.FRONTEND_URL}/pricing`,
          });
        }
        req.limitInfo = { limitKey, feature: true };
        return next();
      }

      const limit = limits[limitKey] ?? 999999;
      let used = 0;

      // ── Ensure usage_tracking row exists for this user ─────────────────
      await query(`
        INSERT INTO usage_tracking (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);

      // ── posts_per_month ────────────────────────────────────────────────
      if (limitKey === 'posts_per_month') {
        const result = await query(`
          SELECT posts_this_month
          FROM usage_tracking
          WHERE user_id = $1
            AND billing_month_start = date_trunc('month', CURRENT_DATE)::DATE
        `, [userId]);

        if (!result.rows.length) {
          // New billing month — reset counter
          await query(`
            UPDATE usage_tracking
            SET posts_this_month = 0,
                billing_month_start = date_trunc('month', CURRENT_DATE)::DATE
            WHERE user_id = $1
          `, [userId]);
          used = 0;
        } else {
          used = result.rows[0].posts_this_month;
        }
      }

      // ── posts_per_day ──────────────────────────────────────────────────
      else if (limitKey === 'posts_per_day') {
        const result = await query(`
          SELECT posts_today, posts_day_reset_at
          FROM usage_tracking WHERE user_id = $1
        `, [userId]);

        const row = result.rows[0];
        const resetDate = row?.posts_day_reset_at;
        const today = new Date().toISOString().slice(0, 10);

        if (!resetDate || resetDate.toISOString().slice(0, 10) !== today) {
          await query(`
            UPDATE usage_tracking
            SET posts_today = 0, posts_day_reset_at = CURRENT_DATE
            WHERE user_id = $1
          `, [userId]);
          used = 0;
        } else {
          used = row.posts_today;
        }
      }

      // ── cv_analyses_per_day ────────────────────────────────────────────
      else if (limitKey === 'cv_analyses_per_day') {
        const result = await query(`
          SELECT cv_analyses_today, cv_day_reset_at
          FROM usage_tracking WHERE user_id = $1
        `, [userId]);

        const row = result.rows[0];
        const today = new Date().toISOString().slice(0, 10);
        const resetDate = row?.cv_day_reset_at?.toISOString().slice(0, 10);

        if (resetDate !== today) {
          await query(`
            UPDATE usage_tracking
            SET cv_analyses_today = 0, cv_day_reset_at = CURRENT_DATE
            WHERE user_id = $1
          `, [userId]);
          used = 0;
        } else {
          used = row?.cv_analyses_today ?? 0;
        }
      }

      // ── job_matches_per_day ────────────────────────────────────────────
      else if (limitKey === 'job_matches_per_day') {
        const result = await query(`
          SELECT job_matches_today, job_day_reset_at
          FROM usage_tracking WHERE user_id = $1
        `, [userId]);

        const row = result.rows[0];
        const today = new Date().toISOString().slice(0, 10);
        const resetDate = row?.job_day_reset_at?.toISOString().slice(0, 10);

        if (resetDate !== today) {
          await query(`
            UPDATE usage_tracking
            SET job_matches_today = 0, job_day_reset_at = CURRENT_DATE
            WHERE user_id = $1
          `, [userId]);
          used = 0;
        } else {
          used = row?.job_matches_today ?? 0;
        }
      }

      // ── trend_refreshes_this_week ──────────────────────────────────────
      else if (limitKey === 'trend_refreshes_this_week') {
        const result = await query(`
          SELECT trend_refreshes_this_week, trend_week_reset_at
          FROM usage_tracking WHERE user_id = $1
        `, [userId]);

        const row = result.rows[0];
        const thisWeekStart = new Date();
        thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
        const thisWeek = thisWeekStart.toISOString().slice(0, 10);
        const resetWeek = row?.trend_week_reset_at?.toISOString().slice(0, 10);

        if (resetWeek !== thisWeek) {
          await query(`
            UPDATE usage_tracking
            SET trend_refreshes_this_week = 0,
                trend_week_reset_at = date_trunc('week', CURRENT_DATE)::DATE
            WHERE user_id = $1
          `, [userId]);
          used = 0;
        } else {
          used = row?.trend_refreshes_this_week ?? 0;
        }
      }

      // ── pillars (live count, not a stored counter) ─────────────────────
      else if (limitKey === 'pillars') {
        const result = await query(`
          SELECT COUNT(*) AS cnt FROM pillars
          WHERE user_id = $1 AND is_active = true
        `, [userId]);
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── unknown limit key ──────────────────────────────────────────────
      else {
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
          upgrade_url: `${process.env.FRONTEND_URL}/pricing`,
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
/**
 * Call this AFTER a successful action to increment the usage counter.
 * Call in route handlers after the action succeeds, not in middleware.
 *
 * Example:
 *   await incrementUsage(userId, 'posts_per_month');
 *   await incrementUsage(userId, 'posts_per_day');
 */
async function incrementUsage(userId, limitKey) {
  try {
    const colMap = {
      posts_per_month:          'posts_this_month = posts_this_month + 1',
      posts_per_day:            'posts_today = posts_today + 1',
      cv_analyses_per_day:      'cv_analyses_today = cv_analyses_today + 1',
      job_matches_per_day:      'job_matches_today = job_matches_today + 1',
      trend_refreshes_this_week:'trend_refreshes_this_week = trend_refreshes_this_week + 1',
    };

    const update = colMap[limitKey];
    if (!update) return; // pillars and features aren't incremented here

    await query(`
      INSERT INTO usage_tracking (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    await query(`
      UPDATE usage_tracking SET ${update} WHERE user_id = $1
    `, [userId]);
  } catch (err) {
    // Never block the response over a usage increment failure
    console.error('[incrementUsage] Failed:', err.message);
  }
}

module.exports = {
  requirePlan,
  checkLimit,
  incrementUsage,
  getLimitsForPlan,
  PLAN_LIMITS,
};
