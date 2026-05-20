/**
 * Plan Enforcement Middleware
 *
 * Usage in routes:
 *   const { requirePlan, checkLimit } = require('../middleware/plan');
 *
 *   // Require a minimum plan
 *   router.post('/generate', requireAuth, requirePlan('starter'), handler);
 *
 *   // Check a usage limit before processing
 *   router.post('/generate', requireAuth, checkLimit('posts_per_month'), handler);
 */

const { query } = require('../db/index');

// ─── Plan Hierarchy ────────────────────────────────────────────────────────

const PLAN_RANK = { free: 0, starter: 1, pro: 2, dfy: 3 };

// ─── Limits Config ────────────────────────────────────────────────────────

const PLAN_LIMITS = {
  free: {
    posts_per_month:        4,
    pillars:                6,
    trend_refreshes_week:   1,
    cv_analyses_per_day:    1,
    job_matches_per_day:    1,
    calendar_weeks:         1,
    email_notifications:    false,
    wa_notifications:       false,
  },
  starter: {
    posts_per_month:        30,
    posts_per_day:          1,
    pillars:                8,
    trend_refreshes_week:   7, // daily
    calendar_weeks:         3,
    cv_analyses_per_day:    10,
    job_matches_per_day:    10,
    email_notifications:    true,
    wa_notifications:       true,
  },
  pro: {
    posts_per_month:        999999,
    posts_per_day:          999999,
    pillars:                999999,
    trend_refreshes_week:   999999,
    calendar_weeks:         999999,
    cv_analyses_per_day:    999999,
    job_matches_per_day:    999999,
    email_notifications:    true,
    wa_notifications:       true,
  },
  dfy: {
    posts_per_month:        999999,
    posts_per_day:          999999,
    pillars:                999999,
    trend_refreshes_week:   999999,
    calendar_weeks:         999999,
    cv_analyses_per_day:    999999,
    job_matches_per_day:    999999,
    email_notifications:    true,
    wa_notifications:       true,
    managed:                true,
  },
};

// ─── requirePlan ──────────────────────────────────────────────────────────

/**
 * Middleware: block request if user's plan is below the required plan
 *
 * @param {string} minPlan - 'starter' | 'pro' | 'dfy'
 */
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const userPlan = req.user?.plan || 'free';

      if ((PLAN_RANK[userPlan] || 0) < (PLAN_RANK[minPlan] || 0)) {
        return res.status(403).json({
          error:    'Plan upgrade required',
          code:     'PLAN_LIMIT',
          required: minPlan,
          current:  userPlan,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─── checkLimit ───────────────────────────────────────────────────────────

/**
 * Middleware: check a usage-count limit before allowing a request
 * Attaches limit metadata to req.limitInfo for use in handler if needed
 *
 * @param {string} limitKey - key from PLAN_LIMITS
 */
function checkLimit(limitKey) {
  return async (req, res, next) => {
    try {
      const userId   = req.user.id;
      const userPlan = req.user.plan || 'free';
      const limits   = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;
      const limit    = limits[limitKey] ?? 999999;

      let used = 0;

      // ── posts_per_month ────────────────────────────────────────────────
      if (limitKey === 'posts_per_month') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM posts
           WHERE user_id = $1
             AND created_at >= date_trunc('month', NOW())`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── posts_per_day ──────────────────────────────────────────────────
      else if (limitKey === 'posts_per_day') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM posts
           WHERE user_id = $1
             AND created_at >= date_trunc('day', NOW())`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── cv_analyses_per_day ────────────────────────────────────────────
      else if (limitKey === 'cv_analyses_per_day') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM notification_log
           WHERE user_id = $1
             AND type = 'cv_analysis'
             AND sent_at >= date_trunc('day', NOW())`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── job_matches_per_day ────────────────────────────────────────────
      else if (limitKey === 'job_matches_per_day') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM notification_log
           WHERE user_id = $1
             AND type = 'job_match'
             AND sent_at >= date_trunc('day', NOW())`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── trend_refreshes_week ───────────────────────────────────────────
      else if (limitKey === 'trend_refreshes_week') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM notification_log
           WHERE user_id = $1
             AND type = 'trend_refresh'
             AND sent_at >= date_trunc('week', NOW())`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      // ── pillars ────────────────────────────────────────────────────────
      else if (limitKey === 'pillars') {
        const result = await query(
          `SELECT COUNT(*) AS cnt FROM pillars WHERE user_id = $1 AND is_active = true`,
          [userId]
        );
        used = parseInt(result.rows[0]?.cnt || 0, 10);
      }

      if (used >= limit) {
        return res.status(403).json({
          error:   'Usage limit reached',
          code:    'USAGE_LIMIT',
          limit_key: limitKey,
          used,
          limit,
          plan:    userPlan,
          upgrade_url: `${process.env.FRONTEND_URL}/pricing`,
        });
      }

      // Attach for use in handlers
      req.limitInfo = { limitKey, used, limit, remaining: limit - used };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─── getLimits helper (for frontend /me or subscription endpoint) ─────────

function getLimitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

module.exports = { requirePlan, checkLimit, getLimitsForPlan, PLAN_LIMITS };
