const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── GET /api/dashboard/stats ─────────────────────────────────────────────────
// Returns all data needed for the dashboard home page
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      profileResult,
      postStatsResult,
      recentPostsResult,
      pillarsResult,
      streakResult,
    ] = await Promise.all([
      // Profile completeness — prefix all columns to avoid ambiguity (full_name exists on both tables)
      query(
        `SELECT p.full_name, p.user_role, p.user_headline, p.sectors, p.voice_tone,
                p.post_length, p.style_notes, p.content_pillars, u.onboarding_complete
         FROM profiles p
         JOIN users u ON u.id = p.user_id
         WHERE p.user_id = $1`,
        [userId]
      ),

      // Post counts by status
      query(
        `SELECT status, COUNT(*) as count FROM posts WHERE user_id = $1 GROUP BY status`,
        [userId]
      ),

      // 5 most recent posts
      query(
        `SELECT p.id, p.topic, p.body, p.status, p.created_at, p.updated_at,
                p.approved_at, pi.pillar_name, pi.pillar_icon
         FROM posts p
         LEFT JOIN pillars pi ON pi.id = p.pillar_id
         WHERE p.user_id = $1
         ORDER BY p.created_at DESC LIMIT 5`,
        [userId]
      ),

      // Active pillars
      query(
        `SELECT id, pillar_name, pillar_icon, is_active FROM pillars
         WHERE user_id = $1 ORDER BY display_order ASC`,
        [userId]
      ),

      // Posting streak — count consecutive days with an approved post
      query(
        `SELECT DATE(approved_at) as day
         FROM posts
         WHERE user_id = $1 AND status = 'approved' AND approved_at IS NOT NULL
         ORDER BY day DESC`,
        [userId]
      ),
    ]);

    // Build post counts map
    const postCounts = { draft: 0, pending: 0, approved: 0, scheduled: 0, published: 0 };
    postStatsResult.rows.forEach((r) => {
      postCounts[r.status] = parseInt(r.count);
    });
    const totalPosts = Object.values(postCounts).reduce((a, b) => a + b, 0);

    // Calculate streak
    const streak = calculateStreak(streakResult.rows.map((r) => r.day));

    // Profile completeness score (0-100)
    const profile = profileResult.rows[0] || {};
    const completeness = calcProfileCompleteness(profile);

    // Checklist items
    const checklist = buildChecklist(profile, pillarsResult.rows, postCounts);

    // Agent status
    const agentStatus = buildAgentStatus(profile, postCounts, pillarsResult.rows);

    res.json({
      profile: {
        full_name: profile.full_name,
        user_role: profile.user_role,
        user_headline: profile.user_headline,
        onboarding_complete: profile.onboarding_complete,
      },
      stats: {
        total_posts: totalPosts,
        posts_this_week: await getPostsThisWeek(userId),
        posts_this_month: await getPostsThisMonth(userId),
        approval_rate: calcApprovalRate(postCounts),
        streak_days: streak,
        active_pillars: pillarsResult.rows.filter((p) => p.is_active).length,
        ...postCounts,
      },
      recent_posts: recentPostsResult.rows,
      pillars: pillarsResult.rows,
      checklist,
      agent_status: agentStatus,
      profile_completeness: completeness,
    });
  } catch (err) {
    console.error('[GET /dashboard/stats]', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// ─── GET /api/dashboard/activity ─────────────────────────────────────────────
// Returns post activity data for the last 30 days (for chart)
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `SELECT DATE(created_at) as day, COUNT(*) as count, status
       FROM posts
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY day, status
       ORDER BY day ASC`,
      [userId]
    );

    // Build 30-day series
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }

    const activityMap = {};
    result.rows.forEach((r) => {
      const day = r.day instanceof Date
        ? r.day.toISOString().split('T')[0]
        : String(r.day).split('T')[0];
      if (!activityMap[day]) activityMap[day] = { generated: 0, approved: 0 };
      if (r.status === 'approved') activityMap[day].approved += parseInt(r.count);
      else activityMap[day].generated += parseInt(r.count);
    });

    const activity = days.map((day) => ({
      day,
      label: new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      generated: activityMap[day]?.generated || 0,
      approved: activityMap[day]?.approved || 0,
    }));

    res.json({ activity });
  } catch (err) {
    console.error('[GET /dashboard/activity]', err.message);
    res.status(500).json({ error: 'Failed to load activity data' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getPostsThisWeek(userId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM posts
     WHERE user_id = $1 AND created_at >= date_trunc('week', NOW())`,
    [userId]
  );
  return parseInt(result.rows[0]?.count || 0);
}

async function getPostsThisMonth(userId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM posts
     WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  return parseInt(result.rows[0]?.count || 0);
}

function calcApprovalRate(counts) {
  const total = counts.approved + counts.draft + counts.pending;
  if (!total) return 0;
  return Math.round((counts.approved / total) * 100);
}

function calculateStreak(days) {
  if (!days.length) return 0;
  let streak = 0;
  const today = new Date().toISOString().split('T')[0];
  const sortedDays = [...new Set(days.map((d) => (d instanceof Date ? d.toISOString().split('T')[0] : d)))].sort().reverse();

  for (let i = 0; i < sortedDays.length; i++) {
    const expected = new Date();
    expected.setDate(expected.getDate() - i);
    const expectedStr = expected.toISOString().split('T')[0];
    if (sortedDays[i] === expectedStr || (i === 0 && sortedDays[0] <= today)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calcProfileCompleteness(profile) {
  const fields = [
    'full_name', 'user_role', 'user_headline', 'sectors',
    'voice_tone', 'post_length', 'style_notes', 'content_pillars',
  ];
  let filled = 0;
  fields.forEach((f) => {
    const v = profile[f];
    if (v && (typeof v !== 'object' || Object.keys(v).length > 0) && v !== '') {
      filled++;
    }
  });
  return Math.round((filled / fields.length) * 100);
}

function buildChecklist(profile, pillars, postCounts) {
  return [
    {
      id: 'onboarding',
      label: 'Complete onboarding',
      done: !!profile.onboarding_complete,
      href: '/onboarding',
    },
    {
      id: 'pillars',
      label: 'Set up content pillars',
      done: pillars.length >= 3,
      href: '/dashboard/profile',
    },
    {
      id: 'first_post',
      label: 'Generate your first post',
      done: (postCounts.draft + postCounts.approved + postCounts.published) > 0,
      href: '/dashboard/generate',
    },
    {
      id: 'approve_post',
      label: 'Approve a post',
      done: postCounts.approved > 0,
      href: '/dashboard/queue',
    },
    {
      id: 'voice',
      label: 'Configure your voice settings',
      done: !!(profile.voice_tone && profile.style_notes),
      href: '/dashboard/profile',
    },
  ];
}

function buildAgentStatus(profile, postCounts, pillars) {
  const activePillars = pillars.filter((p) => p.is_active).length;
  const hasVoice = !!(profile.voice_tone);
  const hasOnboarded = !!profile.onboarding_complete;
  const hasPosts = (postCounts.draft + postCounts.approved) > 0;

  let status = 'inactive';
  let message = 'Complete onboarding to activate your AI co-pilot.';
  let readiness = 0;

  if (hasOnboarded) readiness += 30;
  if (activePillars >= 3) readiness += 25;
  if (hasVoice) readiness += 20;
  if (hasPosts) readiness += 25;

  if (readiness >= 80) {
    status = 'active';
    message = 'Your AI co-pilot is fully operational.';
  } else if (readiness >= 40) {
    status = 'partial';
    message = 'Your co-pilot is warming up — a few more steps to full power.';
  }

  return { status, message, readiness };
}

module.exports = router;
