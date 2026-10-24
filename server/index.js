'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { createSupabase, dbProblem } = require('./db');
const { authenticate, requirePasswordChanged, requireAdmin, LoginLimiter, Revocations } = require('./auth');
const { UserError } = require('./validate');
const authRoutes = require('./routes/auth');
const lookupRoutes = require('./routes/lookups');
const experienceRoutes = require('./routes/experiences');
const { complaintRoutes, webhookRoutes } = require('./routes/complaints');
const kpiRoutes = require('./routes/kpis');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function loadConfig(env = process.env) {
  const config = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: env.JWT_SECRET,
    webhookSecret: env.WEBHOOK_SECRET,
    tz: env.TZ_NAME || 'Asia/Riyadh',
    overdueDays: Number(env.OVERDUE_DAYS || 3),
    port: Number(env.PORT || 3000)
  };
  const missing = ['supabaseUrl', 'supabaseKey', 'jwtSecret', 'webhookSecret'].filter(k => !config[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (!Number.isFinite(config.overdueDays) || config.overdueDays < 0) throw new Error('OVERDUE_DAYS must be a number');
  return config;
}

function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const ctx = { db, config, loginLimiter: new LoginLimiter(), revocations: new Revocations() };

  app.use((req, res, next) => {
    req.ctx = ctx;
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"]
      }
    }
  }));
  app.use(express.json({ limit: '200kb' }));

  // Reports only an error code, never details, so it is safe to leave public.
  app.get('/api/health', async (_req, res) => {
    const problem = await dbProblem(db);
    res.status(problem ? 503 : 200).json({ ok: !problem, service: 'patient-experience', db: problem ? `error:${problem}` : 'ok', time: new Date().toISOString() });
  });
  app.use('/api/auth', authRoutes());
  app.use('/api/webhooks', webhookRoutes());

  const signedIn = [authenticate, requirePasswordChanged];
  app.use('/api/lookups', signedIn, lookupRoutes());
  app.use('/api/experiences', signedIn, experienceRoutes());
  app.use('/api/complaints', signedIn, complaintRoutes());
  app.use('/api/kpis', signedIn, requireAdmin, kpiRoutes());
  app.use('/api/admin', signedIn, requireAdmin, adminRoutes());

  app.use('/api', (_req, _res, next) => next(new UserError('المسار غير موجود', 404)));

  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  // The SPA shell is read once and given a fresh CSP nonce per response.
  const shell = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(shell.replaceAll('__CSP_NONCE__', res.locals.nonce));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = 500;
    let error = 'حدث خطأ غير متوقع';
    if (err && err.userMessage) {
      status = err.status || 400;
      error = err.message;
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; error = 'صيغة الطلب غير صالحة';
    } else if (err && err.type === 'entity.too.large') {
      status = 413; error = 'حجم الطلب كبير';
    } else {
      console.error(`[${req.method} ${req.originalUrl}]`, err && err.stack ? err.stack : err);
    }
    res.status(status).json({ ok: false, error });
  });

  return app;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const config = loadConfig();
  const db = createSupabase(config.supabaseUrl, config.supabaseKey);
  createApp({ db, config }).listen(config.port, () => {
    console.log(`patient-experience listening on :${config.port}`);
  });
  bootstrapAdmin(db).catch(e => console.error('admin bootstrap failed:', e.message));
}

/**
 * First boot only: when there are no users at all, create "admin" and log its temporary
 * password once (Render's free plan has no Shell to run seed-admin.js). It must be changed
 * on first login, and nothing happens once any user exists.
 */
async function bootstrapAdmin(db) {
  const { countOf } = require('./db');
  const { seedAdmin } = require('./seed-admin');
  if (await countOf(db.from('app_users').select('id', { count: 'exact', head: true }))) return;
  const r = await seedAdmin(db);
  if (r.created) console.log(`[first boot] created user "admin" with temporary password: ${r.password} (must be changed at first login)`);
}

module.exports = { createApp, loadConfig };
