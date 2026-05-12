// src/routes/health.js
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');

// GET /api/health
// Public endpoint — no auth required
// Used by keep-alive cron and external uptime monitors
router.get('/', async (req, res) => {
  const start = Date.now();

  try {
    // Check DB connectivity
    await query('SELECT 1');
    const dbLatency = Date.now() - start;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      db: {
        status: 'ok',
        latency_ms: dbLatency,
      },
      env: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      db: {
        status: 'error',
        error: err.message,
      },
    });
  }
});

module.exports = router;
