'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const { apiLimiter }      = require('./middleware/rateLimit');
const authRoutes          = require('./routes/auth');
const profileRoutes       = require('./routes/profile');
const adminRoutes         = require('./routes/admin');
const postsRouter         = require('./routes/posts');
const trendsRouter        = require('./routes/trends');
const dashboardRouter     = require('./routes/dashboard');
const commentsRouter      = require('./routes/comments');
const calendarRouter      = require('./routes/calendar');
const analyticsRouter     = require('./routes/analytics');
const notificationsRouter = require('./routes/notifications');
const settingsRouter      = require('./routes/settings');
const careerRoutes        = require('./routes/career');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Security ──
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── CORS ──
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// ── Body parsing ──
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ──
app.use('/api/', apiLimiter);

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    service: 'SupplAI API',
    status:  'online',
    version: '1.0.0',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Routes ──
app.use('/api/auth',          authRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/posts',         postsRouter);
app.use('/api/trends',        trendsRouter);
app.use('/api/dashboard',     dashboardRouter);
app.use('/api/comments',      commentsRouter);
app.use('/api/calendar',      calendarRouter);
app.use('/api/analytics',     analyticsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings',      settingsRouter);
app.use('/api/career',        careerRoutes);

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n🚀 SupplAI API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV}`);
  console.log(`   Frontend:    ${process.env.FRONTEND_URL}`);
  console.log(`   Database:    ${process.env.DATABASE_URL ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   JWT:         ${process.env.JWT_SECRET ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   Admin:       ${process.env.ADMIN_PASSWORD ? '✅ Configured' : '❌ Missing'}\n`);
});

module.exports = app;
