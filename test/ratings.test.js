'use strict';

// Service-rating QR survey: scoring, webhook, follow-up cases for low ratings, KPIs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { score, assess } = require('../server/ratings');

test('answers in the form\'s wording score 1–5 regardless of spacing', () => {
  assert.equal(score('Strongly agree  أوافق بشدة', 'agree'), 5);
  assert.equal(score('Agree     يوافق', 'agree'), 4);
  assert.equal(score('Neutral   حيادي', 'agree'), 3);
  assert.equal(score('Disagree لا أوافق', 'agree'), 2);
  assert.equal(score('Strongly Disagree   أرفض بشدة', 'agree'), 1);
  assert.equal(score('Definitely yes   بالتأكيد نعم', 'recommend'), 5);
  assert.equal(score('Probably yes ربما نعم', 'recommend'), 4);
  assert.equal(score('Probably not   ربما لا', 'recommend'), 2);
  assert.equal(score('Excellent   ممتاز', 'overall'), 5);
  assert.equal(score('Very good جيد جداً', 'overall'), 4);
  assert.equal(score('Good   جيد', 'overall'), 3);
  assert.equal(score('Poor فقير', 'overall'), 1);
  assert.equal(score('', 'agree'), null);
  assert.equal(score('something else', 'agree'), null);
});

test('only responses with a low answer need follow-up; bottom overall/care is high severity', () => {
  const ok = { q_booking: 5, q_reception: 4, q_waiting: 3, q_explanation: 4, q_care: 4, q_recommend: 4, q_overall: 5 };
  assert.equal(assess(ok), null);
  const wait = assess({ ...ok, q_waiting: 1 });
  assert.equal(wait.severity, 'متوسطة');
  assert.match(wait.summary, /وقت الانتظار/);
  assert.equal(assess({ ...ok, q_overall: 1, q_recommend: 2 }).severity, 'عالية');
});

let t, adminToken, bmToken;
const headers = { 'x-webhook-secret': 'hook-secret' };
const answers = (o = {}) => ({
  q_booking: 'Strongly agree  أوافق بشدة', q_reception: 'Agree يوافق', q_waiting: 'Agree      يوافق', q_explanation: 'Strongly agree أوافق بشدة',
  q_care: 'Agree     يوافق', q_recommend: 'Definitely yes بالتأكيد نعم', q_overall: 'Excellent ممتاز', ...o
});

test.before(async () => {
  t = await startApp();
  t.addUser({ username: 'boss', role: 'admin' });
  t.addUser({ username: 'bm.u', role: 'branch_manager', branch: 'عنيزة' });
  [adminToken, bmToken] = await Promise.all([t.login('boss'), t.login('bm.u')]);
});
test.after(() => t.close());

test('ratings webhook: secret required, scored, idempotent, low ones open a case', async () => {
  const rows = [
    { source_key: 'R:1:2', date: '2026-10-20T10:00:00+03:00', visit_date: '2026-10-20T09:15:00+03:00', branch: 'عنيزة', ...answers() },
    { source_key: 'R:1:3', date: '2026-10-21T10:00:00+03:00', branch: 'عنيزة', ...answers({ q_waiting: 'Strongly disagree    أرفض بشدة', q_overall: 'Poor فقير', q_recommend: 'Probably not   ربما لا' }) },
    { source_key: 'R:1:4', date: '2026-10-21T11:00:00+03:00', branch: 'Buraydah', ...answers({ q_waiting: 'Disagree' }) },
    { source_key: 'R:1:5', q_booking: '', q_overall: '' },
    { source_key: 'R:1:6', patient_name: 'سارة', ...answers() }
  ];
  assert.equal((await t.call('POST', '/api/webhooks/ratings', { body: { rows } })).status, 401);
  const r = await t.call('POST', '/api/webhooks/ratings', { headers, body: { rows } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.inserted, 4, 'the empty row is skipped');
  assert.equal(r.body.flagged, 2);
  const again = await t.call('POST', '/api/webhooks/ratings', { headers, body: { rows } });
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.flagged, 0);

  const stored = t.db._store.tables.service_ratings;
  const one = stored.find(x => x.source_key === 'R:1:2');
  assert.deepEqual([one.q_booking, one.q_reception, one.q_waiting, one.q_explanation, one.q_care, one.q_recommend, one.q_overall], [5, 4, 4, 5, 4, 5, 5]);
  assert.equal(one.visit_at, '2026-10-20T06:15:00.000Z');
  assert.equal(stored.find(x => x.source_key === 'R:1:4').branch, 'بريدة');
  assert.equal(JSON.stringify(t.db._store.tables).includes('سارة'), false, 'unknown fields are dropped');

  const cases = t.db._store.tables.cases.filter(c => c.source === 'تقييم خدمة');
  assert.equal(cases.length, 2);
  const high = cases.find(c => c.source_id === stored.find(x => x.source_key === 'R:1:3').id);
  assert.equal(high.severity, 'عالية');
  assert.equal(high.branch, 'عنيزة');
  assert.match(high.summary, /وقت الانتظار/);
  assert.match(high.summary, /الرضا العام/);

  const detail = await t.call('GET', `/api/cases/${high.id}`, { token: bmToken });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.detail.answers.map(a => a.score), [5, 4, 1, 5, 4, 2, 1]);
});

test('KPIs include service ratings and every patient-voice source; branch managers get their branch', async () => {
  const k = (await t.call('GET', '/api/kpis', { token: adminToken })).body.kpis;
  assert.equal(k.serviceRatings.total, 4);
  assert.equal(k.serviceRatings.lowCount, 2);
  assert.equal(k.serviceRatings.recommendPct, 75);
  const overall = k.serviceRatings.questions.find(q => q.key === 'q_overall');
  assert.deepEqual(overall.dist, [1, 0, 0, 0, 3]);
  assert.equal(overall.avg, 4);
  assert.deepEqual(Object.keys(k.sources).sort(), ['complaints', 'google', 'inPerson', 'phone', 'serviceRatings']);
  assert.equal(k.sources.serviceRatings.total, 4);
  assert.equal(k.sources.serviceRatings.low, 2);
  const bm = (await t.call('GET', '/api/kpis', { token: bmToken })).body.kpis;
  assert.equal(bm.serviceRatings.total, 2, 'R:1:6 has no branch, so it is not in Unaizah');
  assert.ok(bm.serviceRatings.byBranch.every(b => b.branch === 'عنيزة'));
  const ranged = (await t.call('GET', '/api/kpis?from=2026-10-21&to=2026-10-21', { token: adminToken })).body.kpis;
  assert.equal(ranged.serviceRatings.total, 2, 'R:1:6 has no date, so it counts as received now');
});
