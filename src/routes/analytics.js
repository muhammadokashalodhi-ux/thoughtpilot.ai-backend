const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── GET /api/analytics/overview ─────────────────────────────────────────────
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30' } = req.query; // days
    const days = parseInt(period) || 30;

    const [
      totalResult,
      periodResult,
      byStatusResult,
      byPillarResult,
      byTypeResult,
      byDayResult,
      streakResult,
      topPostsResult,
    ] = await Promise.all([
      // All-time totals
      query(`SELECT COUNT(*) as total FROM posts WHERE user_id = $1`, [userId]),

      // Period totals
      query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'approved') as approved,
           COUNT(*) FILTER (WHERE status = 'published') as published,
           COUNT(*) FILTER (WHERE status = 'draft') as draft
         FROM posts WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'`,
        [userId]
      ),

      // All time by status
      query(
        `SELECT status, COUNT(*) as count FROM posts WHERE user_id = $1 GROUP BY status`,
        [userId]
      ),

      // By pillar (all time)
      query(
        `SELECT pi.pillar_name, pi.pillar_icon, COUNT(p.id) as count
         FROM posts p
         LEFT JOIN pillars pi ON pi.id = p.pillar_id
         WHERE p.user_id = $1
         GROUP BY pi.pillar_name, pi.pillar_icon
         ORDER BY count DESC`,
        [userId]
      ),

      // By type
      query(
        `SELECT type, COUNT(*) as count FROM posts WHERE user_id = $1 GROUP BY type ORDER BY count DESC`,
        [userId]
      ),

      // Posts per day over period
      query(
        `SELECT DATE(created_at) as day, COUNT(*) as count,
                COUNT(*) FILTER (WHERE status = 'approved' OR status = 'published') as approved_count
         FROM posts
         WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
         GROUP BY day ORDER BY day ASC`,
        [userId]
      ),

      // Streak
      query(
        `SELECT DATE(approved_at) as day FROM posts
         WHERE user_id = $1 AND status IN ('approved','published') AND approved_at IS NOT NULL
         ORDER BY day DESC`,
        [userId]
      ),

      // Top 5 most recently approved posts
      query(
        `SELECT p.id, p.topic, p.body, p.status, p.approved_at, pi.pillar_name, pi.pillar_icon
         FROM posts p
         LEFT JOIN pillars pi ON pi.id = p.pillar_id
         WHERE p.user_id = $1 AND p.status IN ('approved','published')
         ORDER BY p.approved_at DESC NULLS LAST LIMIT 5`,
        [userId]
      ),
    ]);

    // Build status map
    const statusCounts = {};
    byStatusResult.rows.forEach((r) => { statusCounts[r.status] = parseInt(r.count); });

    // Approval rate
    const totalAll = parseInt(totalResult.rows[0]?.total || 0);
    const approvedAll = (statusCounts.approved || 0) + (statusCounts.published || 0);
    const approvalRate = totalAll > 0 ? Math.round((approvedAll / totalAll) * 100) : 0;

    // Streak
    const streak = calcStreak(streakResult.rows.map((r) => r.day));

    // Fill in the date series
    const dateMap = {};
    byDayResult.rows.forEach((r) => {
      const key = r.day instanceof Date ? r.day.toISOString().split('T')[0] : r.day;
      dateMap[key] = { total: parseInt(r.count), approved: parseInt(r.approved_count) };
    });

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      series.push({
        day: key,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        total: dateMap[key]?.total || 0,
        approved: dateMap[key]?.approved || 0,
      });
    }

    // Weekly averages
    const weeklyAvg = series.length >= 7
      ? Math.round((series.slice(-7).reduce((a, b) => a + b.total, 0) / 7) * 10) / 10
      : 0;

    res.json({
      overview: {
        total_all_time: totalAll,
        total_period: parseInt(periodResult.rows[0]?.total || 0),
        approved_period: parseInt(periodResult.rows[0]?.approved || 0),
        published_period: parseInt(periodResult.rows[0]?.published || 0),
        draft_period: parseInt(periodResult.rows[0]?.draft || 0),
        approval_rate: approvalRate,
        streak_days: streak,
        weekly_avg: weeklyAvg,
      },
      status_breakdown: statusCounts,
      by_pillar: byPillarResult.rows,
      by_type: byTypeResult.rows,
      series,
      top_posts: topPostsResult.rows,
    });
  } catch (err) {
    console.error('[GET /analytics/overview]', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ─── GET /api/analytics/cadence ──────────────────────────────────────────────
// Posting cadence heatmap — which days of week the user posts most
router.get('/cadence', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `SELECT
         TO_CHAR(created_at, 'Dy') as day_short,
         EXTRACT(DOW FROM created_at) as dow,
         EXTRACT(HOUR FROM created_at) as hour,
         COUNT(*) as count
       FROM posts WHERE user_id = $1
       GROUP BY day_short, dow, hour
       ORDER BY dow, hour`,
      [userId]
    );

    // Day totals
    const dayTotals = {};
    const hourTotals = {};
    result.rows.forEach((r) => {
      const dow = parseInt(r.dow);
      const h = parseInt(r.hour);
      dayTotals[dow] = (dayTotals[dow] || 0) + parseInt(r.count);
      hourTotals[h] = (hourTotals[h] || 0) + parseInt(r.count);
    });

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayBreakdown = DAYS.map((label, i) => ({ label, count: dayTotals[i] || 0 }));
    const bestDay = dayBreakdown.reduce((a, b) => (b.count > a.count ? b : a), dayBreakdown[0]);

    res.json({ cadence: result.rows, day_breakdown: dayBreakdown, best_day: bestDay, hour_totals: hourTotals });
  } catch (err) {
    console.error('[GET /analytics/cadence]', err.message);
    res.status(500).json({ error: 'Failed to load cadence data' });
  }
});

function calcStreak(days) {
  if (!days.length) return 0;
  const sorted = [...new Set(
    days.map((d) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)))
  )].sort().reverse();

  let streak = 0;
  for (let i = 0; i < sorted.length; i++) {
    const expected = new Date();
    expected.setDate(expected.getDate() - i);
    const exp = expected.toISOString().split('T')[0];
    if (sorted[i] === exp) streak++;
    else break;
  }
  return streak;
}

module.exports = router;
