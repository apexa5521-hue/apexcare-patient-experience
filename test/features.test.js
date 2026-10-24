'use strict';

// Phone surveys + call list, sheet complaints → branch, Google Business Profile reviews.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, experience } = require('./helpers');
const { parseDate, parseTime } = require('../server/routes/calls');

/* ---------- Google API mock ---------- */

const LOC_B = 'accounts/111/locations/901';
const LOC_U = 'accounts/111/locations/902';
const google = {
  calls: [],
  reviews: {
    [LOC_B]: [
      { reviewId: 'r1', reviewer: { displayName: 'Patient Name One' }, starRating: 'ONE', comment: 'انتظرت ساعة', createTime: '2026-10-20T08:00:00Z', updateTime: '2026-10-20T08:00:00Z' },
      { reviewId: 'r2', reviewer: { displayName: 'Patient Name Two' }, starRating: 'FIVE', comment: 'خدمة ممتازة', createTime: '2026-10-21T08:00:00Z', updateTime: '2026-10-21T08:00:00Z',
        reviewReply: { comment: 'شكراً لك', updateTime: '2026-10-21T09:00:00Z' } }
    ],
    [LOC_U]: [{ reviewId: 'r3', reviewer: { displayName: 'Third' }, starRating: 'FOUR', createTime: '2026-10-22T08:00:00Z', updateTime: '2026-10-22T08:00:00Z' }]
  },
  quotaZero: false
};
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
async function googleHttp(url, opts = {}) {
  google.calls.push({ url, method: opts.method || 'GET', body: opts.body, auth: opts.headers && opts.headers.authorization });
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(opts.body);
    if (p.get('grant_type') === 'authorization_code') {
      return p.get('code') === 'good-code' ? json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    return json(200, { access_token: 'at-2', expires_in: 3600 });
  }
  if (google.quotaZero) return json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Requests' ... limit 0" } });
  if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return json(200, { accounts: [{ name: 'accounts/111' }] });
  if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations')) {
    return json(200, { locations: [
      { name: 'locations/901', title: 'Apex Care Clinics - Buraydah', storefrontAddress: { locality: 'Buraydah', addressLines: ['King Abdulaziz Rd'] } },
      { name: 'locations/902', title: 'مجمع أبكس كير', storefrontAddress: { locality: 'عنيزة' } }
    ] });
  }
  const m = /^https:\/\/mybusiness\.googleapis\.com\/v4\/(accounts\/111\/locations\/90\d)\/reviews(?:\/([^/]+)\/reply)?/.exec(url);
  if (m && m[2] && opts.method === 'PUT') return json(200, { comment: JSON.parse(opts.body).comment, updateTime: '2026-10-24T10:00:00Z' });
  if (m) return json(200, { reviews: google.reviews[m[1]] || [], averageRating: 3, totalReviewCount: 2 });
  return json(404, { error: { message: 'unexpected ' + url } });
}

let t, admin, staffToken, adminToken, doc, docAll, docOnaizah;

test.before(async () => {
  t = await startApp({ googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'csecret', publicUrl: 'https://pe.example.com' }, { http: googleHttp });
  admin = t.addUser({ username: 'boss', role: 'admin' });
  t.addUser({ username: 'reem', role: 'staff', branch: 'بريدة' });
  doc = t.addDoctor({ name: 'Dr. Bassem Al-Malhem', branch: 'بريدة' });
  docOnaizah = t.addDoctor({ name: 'Dr. Naji Al-Harthi', branch: 'عنيزة' });
  docAll = t.addDoctor({ name: 'Dr. Wadaha', specialty: 'جلدية', branch: 'الكل' });
  [adminToken, staffToken] = await Promise.all([t.login('boss'), t.login('reem')]);
});
test.after(() => t.close());

/* ---------- survey channel ---------- */

test('experiences record the survey channel, filter by it and split KPIs by it', async () => {
  const a = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { fileNo: 'CH-1' }) });
  const b = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { fileNo: 'CH-2', channel: 'اتصال', sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'بسيطة' }) });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(t.db._store.tables.experiences.find(e => e.id === a.body.id).channel, 'حضوري', 'defaults to in person');
  assert.equal((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { channel: 'بريد' }) })).status, 400);
  const phoneOnly = await t.call('GET', `/api/experiences?channel=${encodeURIComponent('اتصال')}`, { token: adminToken });
  assert.deepEqual(phoneOnly.body.rows.map(r => r.fileNo), ['CH-2']);
  assert.equal(phoneOnly.body.rows[0].channel, 'اتصال');
  const k = (await t.call('GET', '/api/kpis', { token: adminToken })).body.kpis;
  const by = Object.fromEntries(k.byChannel.map(c => [c.channel, c]));
  assert.equal(by['حضوري'].total, 1);
  assert.equal(by['اتصال'].total, 1);
  assert.equal(by['اتصال'].negPct, 100);
  assert.equal(by['اتصال'].sharePct, 50);
});

/* ---------- call list ---------- */

test('dates and times pasted from Excel are understood', () => {
  assert.equal(parseDate('2026-10-24'), '2026-10-24');
  assert.equal(parseDate('24/10/2026'), '2026-10-24');
  assert.equal(parseDate('2026/10/24 14:30'), '2026-10-24');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseTime('14:30'), '14:30');
  assert.equal(parseTime('2:30 PM'), '14:30');
  assert.equal(parseTime('12:05 am'), '00:05');
  assert.equal(parseTime('9:15 م'), '21:15');
  assert.equal(parseTime('2026-10-24 08:05:00'), '08:05');
});

test('call list: add, outcomes, and a phone survey closes the call', async () => {
  assert.match((await t.call('POST', '/api/calls', { token: staffToken, body: { fileNo: 'Q-1' } })).body.error, /الجوال/);
  const add = await t.call('POST', '/api/calls', { token: staffToken, body: { fileNo: 'Q-1', phone: '+966 50 111 2222', doctorId: doc.id, visitDate: '2026-10-20', visitTime: '10:00' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const dup = await t.call('POST', '/api/calls', { token: staffToken, body: { fileNo: 'Q-1', phone: '0501112222', visitDate: '2026-10-20', visitTime: '10:00' } });
  assert.equal(dup.status, 409);

  let list = await t.call('GET', '/api/calls', { token: staffToken });
  const row = list.body.rows.find(r => r.id === add.body.id);
  assert.equal(row.phone, '0501112222', 'callers see the full number');
  assert.equal(row.branch, 'بريدة', 'branch from the doctor');
  assert.equal(row.visitAt, '2026-10-20 10:00');

  assert.equal((await t.call('PATCH', `/api/calls/${row.id}`, { token: staffToken, body: { status: 'تم' } })).status, 400, 'تم only via the survey');
  await t.call('PATCH', `/api/calls/${row.id}`, { token: staffToken, body: { status: 'لم يرد' } });
  const stored = t.db._store.tables.call_queue.find(c => c.id === row.id);
  assert.equal(stored.attempts, 1);
  assert.ok(stored.last_attempt_at);
  list = await t.call('GET', '/api/calls', { token: staffToken });
  assert.ok(list.body.rows.some(r => r.id === row.id), '"لم يرد" stays in the open list');
  assert.equal(list.body.summary.noAnswer, 1);

  const survey = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { fileNo: 'Q-1', callId: row.id }) });
  assert.equal(survey.status, 201, JSON.stringify(survey.body));
  assert.equal(stored.status, 'تم');
  assert.equal(stored.experience_id, survey.body.id);
  assert.equal(t.db._store.tables.experiences.find(e => e.id === survey.body.id).channel, 'اتصال', 'forced to phone');
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { callId: row.id }) })).body.error, /من قبل/);
  list = await t.call('GET', '/api/calls', { token: staffToken });
  assert.ok(!list.body.rows.some(r => r.id === row.id), 'done calls leave the open list');
  const done = await t.call('GET', `/api/calls?status=${encodeURIComponent('تم')}`, { token: staffToken });
  assert.ok(done.body.rows.some(r => r.id === row.id));
});

test('call list import: admin only, reports bad lines, skips duplicates, matches doctors', async () => {
  const rows = [
    { fileNo: 'IM-1', phone: '0551000001', doctor: 'د. Naji Al-Harthi', visitDate: '23/10/2026', visitTime: '4:30 PM' },
    { fileNo: 'IM-2', phone: '551000002', doctor: 'Dr. Unknown', branch: 'Buraydah', visitDate: '2026-10-23' },
    { fileNo: 'IM-3', phone: '123', visitDate: '2026-10-23' },
    { fileNo: 'ملف', phone: '0551000004' },
    { fileNo: 'IM-1', phone: '0551000001', doctor: 'Dr. Naji Al-Harthi', visitDate: '2026-10-23', visitTime: '16:30' }
  ];
  assert.equal((await t.call('POST', '/api/calls/import', { token: staffToken, body: { rows } })).status, 403);
  const r = await t.call('POST', '/api/calls/import', { token: adminToken, body: { rows } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.inserted, 2);
  assert.deepEqual(r.body.errors.map(e => e.line), [3, 4]);
  const again = await t.call('POST', '/api/calls/import', { token: adminToken, body: { rows: rows.slice(0, 2) } });
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.duplicates, 2);
  const q = t.db._store.tables.call_queue;
  const one = q.find(c => c.file_no === 'IM-1');
  assert.equal(one.doctor_id, docOnaizah.id);
  assert.equal(one.branch, 'عنيزة');
  assert.equal(one.visit_at, '2026-10-23T13:30:00.000Z');
  const two = q.find(c => c.file_no === 'IM-2');
  assert.equal(two.doctor_name_raw, 'Dr. Unknown');
  assert.equal(two.branch, 'بريدة');
  assert.equal(two.phone, '0551000002');
});

/* ---------- sheet complaints → branch ---------- */

test('sheet complaints get their branch from any spelling, else from the doctor', async () => {
  const headers = { 'x-webhook-secret': 'hook-secret' };
  const rows = [
    { source_key: 'br:1', branch: 'فرع عنيزة', description: 'a' },
    { source_key: 'br:2', branch: 'BURAYDAH', description: 'b' },
    { source_key: 'br:3', doctor: 'Dr Naji Al-Harthi', description: 'c' },
    { source_key: 'br:4', doctor: 'Dr. Wadaha', description: 'd' },
    { source_key: 'br:5', branch: 'جدة', description: 'e' }
  ];
  const r = await t.call('POST', '/api/webhooks/complaints', { headers, body: { rows } });
  assert.equal(r.body.inserted, 5);
  const b = k => t.db._store.tables.complaints.find(c => c.source_key === k).branch;
  assert.equal(b('br:1'), 'عنيزة');
  assert.equal(b('br:2'), 'بريدة');
  assert.equal(b('br:3'), 'عنيزة', 'from the doctor');
  assert.equal(b('br:4'), null, 'doctor works in both branches');
  assert.equal(b('br:5'), null);
  const onaizah = await t.call('GET', `/api/complaints?branch=${encodeURIComponent('عنيزة')}`, { token: adminToken });
  assert.ok(['br:1', 'br:3'].every(k => onaizah.body.rows.some(x => x.description === (k === 'br:1' ? 'a' : 'c'))));
});

/* ---------- Google reviews ---------- */

test('google: connect needs credentials, staff cannot manage it', async () => {
  const bare = await startApp();
  const a = bare.addUser({ username: 'boss2', role: 'admin' });
  assert.ok(a);
  const tok = await bare.login('boss2');
  const r = await bare.call('GET', '/api/google/connect', { token: tok });
  await bare.close();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /GOOGLE_CLIENT_ID/);
  assert.equal((await t.call('GET', '/api/google/connect', { token: staffToken })).status, 403);
  assert.equal((await t.call('POST', '/api/reviews/sync', { token: staffToken })).status, 403);
});

test('google: full flow — connect, map locations, sync without reviewer names, reply, follow-up', async () => {
  const before = await t.call('GET', '/api/reviews', { token: adminToken });
  assert.equal(before.body.google.configured, true);
  assert.equal(before.body.google.connected, false);

  const c = await t.call('GET', '/api/google/connect', { token: adminToken });
  const url = new URL(c.body.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://pe.example.com/api/google/callback');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
  const state = url.searchParams.get('state');

  const forged = await fetch(`${t.base}/api/google/callback?code=good-code&state=forged`, { redirect: 'manual' });
  assert.match(forged.headers.get('location'), /google=error/);
  const badCode = await fetch(`${t.base}/api/google/callback?code=bad&state=${state}`, { redirect: 'manual' });
  assert.match(badCode.headers.get('location'), /google=error/);
  const ok = await fetch(`${t.base}/api/google/callback?code=good-code&state=${state}`, { redirect: 'manual' });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /google=connected/);
  assert.equal(t.db._store.tables.app_settings.find(s => s.key === 'google_refresh_token').value, 'rt-1');

  const locs = await t.call('GET', '/api/google/locations', { token: adminToken });
  assert.equal(locs.status, 200, JSON.stringify(locs.body));
  assert.deepEqual(locs.body.rows.map(l => [l.location, l.branch]), [[LOC_B, 'بريدة'], [LOC_U, 'عنيزة']], 'branch guessed from the address');
  assert.equal((await t.call('POST', '/api/reviews/sync', { token: adminToken })).status, 409, 'nothing mapped yet');
  await t.call('POST', '/api/google/locations', { token: adminToken, body: { locations: locs.body.rows.map(l => ({ location: l.location, title: l.title, branch: l.branch })) } });

  const sync = await t.call('POST', '/api/reviews/sync', { token: adminToken });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.fetched, 3);
  const stored = t.db._store.tables.google_reviews;
  assert.equal(stored.length, 3);
  assert.equal(JSON.stringify(stored).includes('Patient Name'), false, 'reviewer names are not stored');
  assert.equal(stored.find(r => r.id === 'r1').rating, 1);
  assert.equal(stored.find(r => r.id === 'r3').branch, 'عنيزة');
  assert.equal(stored.find(r => r.id === 'r2').reply, 'شكراً لك');

  // staff can read; summary per branch
  const list = await t.call('GET', '/api/reviews', { token: staffToken });
  assert.equal(list.status, 200);
  const br = Object.fromEntries(list.body.summary.branches.map(b => [b.branch, b]));
  assert.equal(br['بريدة'].count, 2);
  assert.equal(br['بريدة'].avg, 3);
  assert.equal(br['بريدة'].unreplied, 1);
  assert.equal(br['بريدة'].low, 1);
  assert.deepEqual(br['بريدة'].dist, [1, 0, 0, 0, 1]);
  const low = await t.call('GET', '/api/reviews?replied=no&rating=1', { token: staffToken });
  assert.deepEqual(low.body.rows.map(r => r.id), ['r1']);
  assert.equal((await t.call('POST', '/api/reviews/r1/reply', { token: staffToken, body: { comment: 'x' } })).status, 403);

  // follow-up then re-sync keeps it
  await t.call('PATCH', '/api/reviews/r1', { token: adminToken, body: { status: 'تمت المراجعة', note: 'تواصلنا مع المريض' } });
  await t.call('POST', '/api/reviews/sync', { token: adminToken });
  assert.equal(stored.find(r => r.id === 'r1').status, 'تمت المراجعة');
  assert.equal(stored.find(r => r.id === 'r1').note, 'تواصلنا مع المريض');

  // reply goes to Google, then is saved
  const rep = await t.call('POST', '/api/reviews/r1/reply', { token: adminToken, body: { comment: 'نعتذر عن التأخير، تواصلنا معك' } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const put = google.calls.find(x => x.method === 'PUT');
  assert.equal(put.url, `https://mybusiness.googleapis.com/v4/${LOC_B}/reviews/r1/reply`);
  assert.match(put.auth, /^Bearer at-/);
  assert.equal(stored.find(r => r.id === 'r1').reply, 'نعتذر عن التأخير، تواصلنا معك');
});

test('google: a project without API approval gets a clear Arabic message', async () => {
  google.quotaZero = true;
  try {
    const r = await t.call('POST', '/api/reviews/sync', { token: adminToken });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /طلب الوصول/);
  } finally {
    google.quotaZero = false;
  }
});
