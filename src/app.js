require('dotenv').config();
require('express-async-errors');

const express      = require('express');
const cors         = require('cors');
const pool         = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const authMiddleware = require('./middleware/authMiddleware');
const { pricesMiddleware } = require('./middleware/authMiddleware');
const authRouter = require('./routes/auth');
const { startSyncJob, runScheduledSync } = require('./services/odooSyncService');

const app = express();

// ── Global request logger ─────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[BACKEND REQUEST] ${req.method} ${req.url}`);
  next();
});

app.use(cors());
// Recipe payloads can include base64-encoded images on items.image_url.
// The client now accepts photos up to 20 MB raw and auto-downscales
// oversized photos in-browser to a sane JPEG; on the wire the worst
// realistic case is roughly 18 MB of base64 once inflation is added.
// 25 MB gives comfortable headroom without inviting unbounded uploads.
app.use(express.json({ limit: '25mb' }));

// ── Public routes (no auth required) ─────────────────────────────────────────
app.use('/api/auth', authRouter);

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

// ── Protected routes (JWT required) ──────────────────────────────────────────
// authMiddleware → loads req.localUser from DB (live role + flags)
// pricesMiddleware → wraps res.json to strip prices for users who
//                    cannot view them (role-based + per-user override)
app.use('/api/items',      authMiddleware, pricesMiddleware, require('./routes/items'));
app.use('/api/products',   authMiddleware, pricesMiddleware, require('./routes/products'));
app.use('/api/boms',       authMiddleware, pricesMiddleware, require('./routes/boms'));
app.use('/api/test-recipes', authMiddleware, pricesMiddleware, require('./routes/testRecipes'));
app.use('/api/reference-codes', authMiddleware, pricesMiddleware, require('./routes/referenceCodeCategories'));
app.use('/api/recipe-io',  authMiddleware, pricesMiddleware, require('./routes/recipeIO'));
app.use('/api/pricing',    authMiddleware, pricesMiddleware, require('./routes/pricing'));
app.use('/api/sync',       authMiddleware, pricesMiddleware, require('./routes/sync'));
app.use('/api/categories', authMiddleware, pricesMiddleware, require('./routes/categories'));
app.use('/api/users',      authMiddleware, pricesMiddleware, require('./routes/users'));
app.use('/api/audit-logs', authMiddleware, pricesMiddleware, require('./routes/auditLogs'));
app.use('/api/role-permissions', authMiddleware, pricesMiddleware, require('./routes/rolePermissions'));

// ── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[app] BOM System listening on port ${PORT}`);

  // Loud, unmissable warning when the dev-login bypass is active.
  // ALLOW_DEV_LOGIN must NEVER be 'true' in production.
  if (authRouter.devLoginEnabled && authRouter.devLoginEnabled()) {
    const user = process.env.DEV_ADMIN_USER || '(unset)';
    console.warn('');
    console.warn('================================================================');
    console.warn('  ⚠  ALLOW_DEV_LOGIN=true — DEV ADMIN BYPASS IS ACTIVE');
    console.warn(`     Dev user "${user}" can log in WITHOUT Odoo.`);
    console.warn('     DISABLE before deploying to production.');
    console.warn('================================================================');
    console.warn('');
  }

  // Start the Odoo sync cron job
  try {
    startSyncJob();
    // Optional: run an immediate sync on startup.  runScheduledSync
    // wraps syncFromOdoo with audit logging (user_id=null, reason=
    // 'startup') so the boot-time sync is traceable like cron runs.
    if (process.env.SYNC_ON_START === 'true') {
      await runScheduledSync('startup');
    }
  } catch (err) {
    console.error('[app] Failed to start sync job:', err.message);
  }
});

module.exports = app;
