'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { must, fetchAll, audit } = require('../db');
const { requireAdmin } = require('../auth');
const { formatLocal, localToUtc, addDays } = require('../time');
const { UserError, BRANCHES, parse, parseFilters } = require('../validate');
const G = require('../google');

const AUTO_SYNC_MS = 30 * 60 * 1000;
const REVIEW_STATUSES = ['جديد', 'تمت المراجعة'];

function mapReview(r, tz) {
  return {
    id: r.id, branch: r.branch || '', rating: r.rating, comment: r.comment || '',
    createdAt: formatLocal(r.created_at, tz), reply: r.reply || '', repliedAt: formatLocal(r.replied_at, tz),
    status: r.status, note: r.note || '', handledBy: r.handled_by || ''
  };
}

/** Background refresh when the data is stale; one at a time, never blocks the request. */
function maybeAutoSync(ctx, st) {
  if (!st.connected || ctx.reviewSyncing) return;
  if (st.lastSync && Date.now() - new Date(st.lastSync) < AUTO_SYNC_MS) return;
  if (!st.locations.some(l => l.branch)) return;
  ctx.reviewSyncing = true;
  G.syncReviews(ctx).catch(e => console.error('auto review sync failed:', e.message)).finally(() => { ctx.reviewSyncing = false; });
}

function reviewRoutes() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const st = await G.status(req.ctx);
    const f = parseFilters({ from: req.query.from, to: req.query.to, branch: req.query.branch });
    const rating = Number(req.query.rating) || null;
    const replied = req.query.replied;
    const status = REVIEW_STATUSES.includes(req.query.status) ? req.query.status : null;
    const all = await fetchAll(() => db.from('google_reviews').select('*').order('created_at', { ascending: false }).order('id'));

    const from = f.from ? localToUtc(f.from, '00:00', config.tz).toISOString() : null;
    const to = f.to ? localToUtc(addDays(f.to, 1), '00:00', config.tz).toISOString() : null;
    const rows = all.filter(x =>
      (!from || x.created_at >= from) && (!to || x.created_at < to) && (!f.branch || x.branch === f.branch) &&
      (!rating || x.rating === rating) && (!status || x.status === status) &&
      (replied === 'yes' ? !!x.reply : replied === 'no' ? !x.reply : true));

    const summarize = (list) => {
      const rated = list.filter(x => x.rating);
      return {
        count: list.length,
        avg: rated.length ? Math.round((rated.reduce((a, x) => a + x.rating, 0) / rated.length) * 100) / 100 : null,
        unreplied: list.filter(x => !x.reply).length,
        low: list.filter(x => x.rating && x.rating <= 2).length,
        newCount: list.filter(x => x.status === 'جديد').length,
        dist: [1, 2, 3, 4, 5].map(s => list.filter(x => x.rating === s).length)
      };
    };
    maybeAutoSync(req.ctx, st);
    res.json({
      ok: true,
      google: { configured: st.configured, connected: st.connected, lastSync: formatLocal(st.lastSync, config.tz),
        mapped: st.locations.filter(l => l.branch).map(l => ({ title: l.title, branch: l.branch })) },
      summary: { all: summarize(rows), branches: BRANCHES.map(b => ({ branch: b, ...summarize(rows.filter(x => x.branch === b)) })) },
      total: rows.length,
      rows: rows.slice(0, 500).map(x => mapReview(x, config.tz))
    });
  });

  r.patch('/:id', requireAdmin, async (req, res) => {
    const { db } = req.ctx;
    const d = parse(z.object({
      status: z.string().refine(v => REVIEW_STATUSES.includes(v), 'قيمة غير صالحة: الحالة'),
      note: z.preprocess(v => (v ?? ''), z.string().trim().max(1000)).transform(v => v || null)
    }), req.body);
    const rows = await must(db.from('google_reviews').update({ ...d, handled_by: req.user.username }).eq('id', String(req.params.id)).select('id'));
    if (!rows.length) throw new UserError('التقييم غير موجود', 404);
    await audit(db, req.user.username, 'review_status', `${req.params.id} -> ${d.status}`);
    res.json({ ok: true });
  });

  r.post('/:id/reply', requireAdmin, async (req, res) => {
    const { db } = req.ctx;
    const { comment } = parse(z.object({
      comment: z.string({ error: 'اكتب نص الرد' }).trim().min(1, 'اكتب نص الرد').max(4000, 'الرد طويل (الحد 4000 حرف)')
    }), req.body);
    const review = await must(db.from('google_reviews').select('id,location').eq('id', String(req.params.id)).maybeSingle());
    if (!review) throw new UserError('التقييم غير موجود', 404);
    const at = await G.postReply(req.ctx, review, comment);
    await must(db.from('google_reviews').update({ reply: comment, replied_at: at, status: 'تمت المراجعة', handled_by: req.user.username }).eq('id', review.id));
    await audit(db, req.user.username, 'review_reply', review.id);
    res.json({ ok: true });
  });

  r.post('/sync', requireAdmin, async (req, res) => {
    if (req.ctx.reviewSyncing) throw new UserError('التحديث جارٍ الآن، انتظر قليلاً', 409);
    req.ctx.reviewSyncing = true;
    try {
      const out = await G.syncReviews(req.ctx);
      await audit(req.ctx.db, req.user.username, 'review_sync', `fetched=${out.fetched}`);
      res.json({ ok: true, ...out });
    } finally {
      req.ctx.reviewSyncing = false;
    }
  });

  return r;
}

/* ---------- Google connection (admin) ---------- */

const STATE_PURPOSE = 'google-oauth';

function googleRoutes() {
  const r = express.Router();

  r.get('/connect', async (req, res) => {
    if (!G.configured(req.ctx.config)) throw new UserError('أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في إعدادات Render أولاً', 409);
    const state = jwt.sign({ purpose: STATE_PURPOSE, sub: req.user.id }, req.ctx.config.jwtSecret, { algorithm: 'HS256', expiresIn: 900 });
    res.json({ ok: true, url: G.authUrl(req.ctx.config, req, state) });
  });

  r.get('/locations', async (req, res) => {
    const [google, saved] = await Promise.all([G.listGoogleLocations(req.ctx), G.getLocations(req.ctx.db)]);
    const savedBy = new Map(saved.map(l => [l.location, l.branch]));
    res.json({ ok: true, rows: google.map(l => ({ ...l, branch: savedBy.has(l.location) ? savedBy.get(l.location) : l.suggestedBranch })) });
  });

  r.post('/locations', async (req, res) => {
    const { locations } = parse(z.object({
      locations: z.array(z.object({
        location: z.string().regex(/^accounts\/[^/]+\/locations\/[^/]+$/, 'موقع غير صالح'),
        title: z.string().max(200).optional(),
        branch: z.preprocess(v => v || null, z.string().refine(v => BRANCHES.includes(v), 'قيمة غير صالحة: الفرع').nullable())
      })).max(50)
    }), req.body);
    const mapped = locations.filter(l => l.branch);
    await G.setSetting(req.ctx.db, G.KEYS.locations, JSON.stringify(mapped));
    await audit(req.ctx.db, req.user.username, 'google_locations', mapped.map(l => `${l.branch}:${l.title || l.location}`).join(' | '));
    res.json({ ok: true, mapped: mapped.length });
  });

  r.post('/disconnect', async (req, res) => {
    await G.setSetting(req.ctx.db, G.KEYS.refresh, null);
    req.ctx.googleToken = null;
    await audit(req.ctx.db, req.user.username, 'google_disconnect', '');
    res.json({ ok: true });
  });

  return r;
}

/** Public: Google redirects the admin's browser here after consent. Verified by the signed state. */
function googleCallback() {
  const r = express.Router();
  r.get('/callback', async (req, res) => {
    const back = (q) => res.redirect(303, `/?${new URLSearchParams(q)}#reviews`);
    let claims;
    try {
      claims = jwt.verify(String(req.query.state || ''), req.ctx.config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return back({ google: 'error', reason: 'state' });
    }
    if (claims.purpose !== STATE_PURPOSE) return back({ google: 'error', reason: 'state' });
    if (req.query.error || !req.query.code) return back({ google: 'error', reason: String(req.query.error || 'denied').slice(0, 40) });
    const admin = await must(req.ctx.db.from('app_users').select('username,role,active').eq('id', claims.sub).maybeSingle());
    if (!admin || !admin.active || admin.role !== 'admin') return back({ google: 'error', reason: 'user' });
    try {
      await G.exchangeCode(req.ctx, req, String(req.query.code));
    } catch (e) {
      console.error('google callback:', e.message);
      return back({ google: 'error', reason: 'token' });
    }
    await audit(req.ctx.db, admin.username, 'google_connect', '');
    back({ google: 'connected' });
  });
  return r;
}

module.exports = { reviewRoutes, googleRoutes, googleCallback };
