'use strict';

// Google Business Profile client: OAuth (offline access), locations, reviews and replies.
// Docs: https://developers.google.com/my-business/reference/rest
// The HTTP function is injected (ctx.http) so tests run without the network.

const { must } = require('./db');
const { openCases } = require('./cases');
const { UserError, normalizeBranch, BRANCHES } = require('./validate');

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS_API = 'https://mybusiness.googleapis.com/v4';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
// Incremental syncs stop early anyway; the first one may need the whole history.
const MAX_PAGES_INCREMENTAL = 20;
const MAX_PAGES_FULL = 1000; // 50 per page → up to 50,000 reviews per location
// Only recent low reviews open a follow-up case; older ones are stored and analysed but not chased.
const CASE_WINDOW_DAYS = 30;

/** True when a review was written within the last CASE_WINDOW_DAYS. */
function isRecent(createdAt, now = Date.now()) {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now - t <= CASE_WINDOW_DAYS * 24 * 3600 * 1000;
}

const KEYS = { refresh: 'google_refresh_token', locations: 'google_locations', lastSync: 'google_last_sync' };

/* ---------- settings (server-only table) ---------- */

async function getSetting(db, key) {
  const row = await must(db.from('app_settings').select('value').eq('key', key).maybeSingle());
  return row ? row.value : null;
}
async function setSetting(db, key, value) {
  await must(db.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }));
}

async function getLocations(db) {
  try { return JSON.parse((await getSetting(db, KEYS.locations)) || '[]'); } catch { return []; }
}

/* ---------- OAuth ---------- */

function configured(config) {
  return !!(config.googleClientId && config.googleClientSecret);
}

function redirectUri(config, req) {
  const base = (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/google/callback`;
}

function authUrl(config, req, state) {
  const p = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(config, req), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(ctx, params) {
  const res = await ctx.http(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.config.googleClientId, client_secret: ctx.config.googleClientSecret, ...params }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new UserError('انتهى ربط حساب قوقل أو أُلغي. اربطه من جديد', 409);
    throw new UserError('تعذّر التحقق مع قوقل. راجع GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET', 502);
  }
  return body;
}

async function exchangeCode(ctx, req, code) {
  const t = await tokenRequest(ctx, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx.config, req) });
  if (!t.refresh_token) throw new UserError('قوقل لم ترسل صلاحية دائمة. أزل وصول التطبيق من حساب قوقل ثم اربط من جديد', 502);
  await setSetting(ctx.db, KEYS.refresh, t.refresh_token);
  ctx.googleToken = { value: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
}

async function accessToken(ctx) {
  if (ctx.googleToken && ctx.googleToken.exp > Date.now()) return ctx.googleToken.value;
  const refresh = await getSetting(ctx.db, KEYS.refresh);
  if (!refresh) throw new UserError('حساب قوقل غير مربوط بعد', 409);
  const t = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: refresh });
  ctx.googleToken = { value: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
  return t.access_token;
}

/** Authenticated call to a Google API, with Arabic errors for the cases admins will actually hit. */
async function gapi(ctx, url, { method = 'GET', body } = {}) {
  const res = await ctx.http(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken(ctx)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const status = json.error && json.error.status;
  const msg = String((json.error && json.error.message) || '');
  console.error(`google ${method} ${url.split('?')[0]} -> ${res.status} ${status || ''} ${msg.slice(0, 200)}`);
  if (res.status === 401) { ctx.googleToken = null; throw new UserError('انتهت صلاحية ربط قوقل. اربطه من جديد', 409); }
  if (res.status === 429 || /quota/i.test(msg)) {
    throw new UserError('قوقل لم تفعّل صلاحية Business Profile API لهذا المشروع بعد (الحصة صفر). انتظر موافقة طلب الوصول', 503);
  }
  if (res.status === 403) {
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw new UserError('واجهات Business Profile غير مفعّلة في مشروع Google Cloud. فعّلها من APIs & Services', 503);
    throw new UserError('حساب قوقل المربوط لا يملك صلاحية إدارة هذا الموقع', 403);
  }
  if (res.status === 404) throw new UserError('الموقع أو التقييم غير موجود في قوقل', 404);
  throw new UserError('تعذّر الاتصال بقوقل. حاول لاحقاً', 502);
}

/* ---------- data ---------- */

/** Every location the connected account manages, with a branch guessed from its title/address. */
async function listGoogleLocations(ctx) {
  const out = [];
  const { accounts = [] } = await gapi(ctx, ACCOUNTS_URL);
  for (const acc of accounts) {
    let pageToken = '';
    do {
      const p = new URLSearchParams({ readMask: 'name,title,storefrontAddress', pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const r = await gapi(ctx, `${INFO_API}/${acc.name}/locations?${p}`);
      for (const l of r.locations || []) {
        const address = l.storefrontAddress ? [l.storefrontAddress.locality, ...(l.storefrontAddress.addressLines || [])].filter(Boolean).join('، ') : '';
        out.push({ location: `${acc.name}/${l.name}`, title: l.title || '', address, suggestedBranch: normalizeBranch(`${l.title} ${address}`) });
      }
      pageToken = r.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

function reviewRow(r, loc) {
  return {
    id: r.reviewId,
    location: loc.location,
    branch: BRANCHES.includes(loc.branch) ? loc.branch : null,
    rating: STARS[r.starRating] || null,
    // Reviewer names are intentionally dropped: no patient names in this system.
    comment: r.comment ? String(r.comment).slice(0, 4000) : null,
    created_at: r.createTime,
    updated_at: r.updateTime || r.createTime,
    reply: r.reviewReply ? String(r.reviewReply.comment || '').slice(0, 4000) : null,
    replied_at: r.reviewReply ? r.reviewReply.updateTime || null : null,
    fetched_at: new Date().toISOString()
  };
}

/**
 * Pulls reviews (newest first) for every mapped location and upserts them.
 * Stops paging once it reaches reviews unchanged since the last sync.
 * status/note/handled_by are never sent, so admin follow-up survives re-syncs.
 */
async function syncReviews(ctx) {
  const locations = (await getLocations(ctx.db)).filter(l => l.branch);
  if (!locations.length) throw new UserError('اختر موقع قوقل لكل فرع أولاً', 409);
  const since = await getSetting(ctx.db, KEYS.lastSync);
  const started = new Date().toISOString();
  let fetched = 0;
  for (const loc of locations) {
    let pageToken = '';
    for (let page = 0; page < (since ? MAX_PAGES_INCREMENTAL : MAX_PAGES_FULL); page++) {
      const p = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
      const r = await gapi(ctx, `${REVIEWS_API}/${loc.location}/reviews?${p}`);
      const reviews = r.reviews || [];
      if (reviews.length) {
        const rows = reviews.map(x => reviewRow(x, loc));
        await must(ctx.db.from('google_reviews').upsert(rows, { onConflict: 'id' }));
        // One or two stars from the last 30 days open a follow-up case (once per review).
        await openCases(ctx.db, rows.filter(x => x.rating && x.rating <= 2 && isRecent(x.created_at)).map(x => ({
          source: 'تقييم قوقل', source_id: x.id, created_at: x.created_at, branch: x.branch,
          summary: x.comment || `تقييم ${x.rating} نجوم بدون تعليق`, severity: x.rating === 1 ? 'عالية' : 'متوسطة'
        })));
        fetched += reviews.length;
      }
      const reachedOld = since && reviews.some(x => (x.updateTime || x.createTime) < since);
      pageToken = r.nextPageToken || '';
      if (!pageToken || reachedOld) break;
    }
  }
  await setSetting(ctx.db, KEYS.lastSync, started);
  return { fetched, locations: locations.length };
}

async function postReply(ctx, review, comment) {
  const r = await gapi(ctx, `${REVIEWS_API}/${review.location}/reviews/${review.id}/reply`, { method: 'PUT', body: { comment } });
  return r.updateTime || new Date().toISOString();
}

async function status(ctx) {
  const [refresh, locations, lastSync] = await Promise.all([
    getSetting(ctx.db, KEYS.refresh), getLocations(ctx.db), getSetting(ctx.db, KEYS.lastSync)
  ]);
  return { configured: configured(ctx.config), connected: !!refresh, locations, lastSync };
}

module.exports = {
  isRecent, CASE_WINDOW_DAYS,
  KEYS, configured, authUrl, exchangeCode, listGoogleLocations, syncReviews, postReply, status,
  getSetting, setSetting, getLocations
};
