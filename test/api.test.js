'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, experience } = require('./helpers');

let t;
let admin, staff, other, doc, docOnaizah;
let adminToken, staffToken, otherToken;

test.before(async () => {
  t = await startApp();
  admin = t.addUser({ username: 'boss', role: 'admin' });
  staff = t.addUser({ username: 'reem', role: 'staff', branch: 'بريدة' });
  other = t.addUser({ username: 'noura', role: 'staff', branch: 'بريدة' });
  doc = t.addDoctor({ name: 'د. سارة العتيبي', branch: 'بريدة' });
  docOnaizah = t.addDoctor({ name: 'د. خالد', branch: 'عنيزة', specialty: 'جلدية' });
  [adminToken, staffToken, otherToken] = await Promise.all([t.login('boss'), t.login('reem'), t.login('noura')]);
});
test.after(() => t.close());

test('health check is public', async () => {
  const r = await t.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('login: wrong password is rejected and audited', async () => {
  const r = await t.call('POST', '/api/auth/login', { body: { username: 'reem', password: 'nope' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /غير صحيحة/);
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'login_failed' && a.username === 'reem'));
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'login' && a.username === 'boss'));
});

test('login: 5 failures within 10 minutes lock the username', async () => {
  t.addUser({ username: 'locked.user' });
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', { body: { username: 'locked.user', password: 'bad' } });
  const r = await t.call('POST', '/api/auth/login', { body: { username: 'locked.user', password: 'password123' } });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /إيقاف المحاولات/);
});

test('login: disabled accounts cannot sign in', async () => {
  t.addUser({ username: 'gone', active: false });
  const r = await t.call('POST', '/api/auth/login', { body: { username: 'gone', password: 'password123' } });
  assert.equal(r.status, 401);
});

test('requests without a valid token get 401', async () => {
  assert.equal((await t.call('GET', '/api/lookups')).status, 401);
  assert.equal((await t.call('GET', '/api/lookups', { token: 'garbage' })).status, 401);
});

test('must_change blocks everything except me / change-password / logout', async () => {
  t.addUser({ username: 'newbie', mustChange: true, password: 'temp-pass-1' });
  const token = await t.login('newbie', 'temp-pass-1');
  const me = await t.call('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.mustChange, true);
  for (const [m, p] of [['GET', '/api/lookups'], ['GET', '/api/experiences'], ['POST', '/api/experiences'], ['GET', '/api/complaints'], ['POST', '/api/complaints']]) {
    const r = await t.call(m, p, { token, body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.body.error, /تغيير كلمة المرور/);
  }
  const short = await t.call('POST', '/api/auth/change-password', { token, body: { oldPassword: 'temp-pass-1', newPassword: 'short' } });
  assert.equal(short.status, 400);
  const same = await t.call('POST', '/api/auth/change-password', { token, body: { oldPassword: 'temp-pass-1', newPassword: 'temp-pass-1' } });
  assert.match(same.body.error, /مختلفة/);
  const wrong = await t.call('POST', '/api/auth/change-password', { token, body: { oldPassword: 'nope', newPassword: 'brand-new-pass' } });
  assert.match(wrong.body.error, /الحالية غير صحيحة/);
  const ok = await t.call('POST', '/api/auth/change-password', { token, body: { oldPassword: 'temp-pass-1', newPassword: 'brand-new-pass' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { token })).status, 401, 'tokens from before the change stop working');
  assert.equal((await t.call('GET', '/api/lookups', { token: ok.body.token })).status, 200);
});

test('logout revokes the token', async () => {
  t.addUser({ username: 'leaver' });
  const token = await t.login('leaver');
  assert.equal((await t.call('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { token })).status, 401);
});

test('lookups list active doctors and categories', async () => {
  t.addDoctor({ name: 'د. متقاعد', active: false });
  const r = await t.call('GET', '/api/lookups', { token: staffToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.lookups.doctors.some(d => d.id === doc.id));
  assert.ok(!r.body.lookups.doctors.some(d => d.name === 'د. متقاعد'));
  assert.equal(r.body.lookups.categories.length, 14);
  assert.deepEqual(r.body.lookups.planAnswers, ['نعم', 'جزئياً', 'لا', 'لا ينطبق']);
});

test('experience: valid one is stored with specialty from the doctor record', async () => {
  const r = await t.call('POST', '/api/experiences', {
    token: staffToken,
    body: experience(doc.id, { phone: '+966 55 123 4567', specialty: 'جلدية', generalNote: 'شكراً' })
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = t.db._store.tables.experiences.find(e => e.id === r.body.id);
  assert.equal(row.specialty, 'أسنان');
  assert.equal(row.phone, '0551234567');
  assert.equal(row.created_by, staff.id);
  assert.equal(row.visit_at, '2026-03-10T07:30:00.000Z');
  assert.equal(row.visit_time_local, '10:30:00');
  assert.equal(row.follow_up, null);
  assert.equal(row.general_note, 'شكراً');
});

test('experience: negative without category is rejected; with one it opens a follow-up', async () => {
  const bad = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { sentiment: 'سلبية' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /تصنيف/);
  const unknownCat = await t.call('POST', '/api/experiences', {
    token: staffToken, body: experience(doc.id, { sentiment: 'سلبية', category: 'تصنيف وهمي', severity: 'عالية' })
  });
  assert.match(unknownCat.body.error, /التصنيف/);
  const positiveCatOnNegative = await t.call('POST', '/api/experiences', {
    token: staffToken, body: experience(doc.id, { sentiment: 'سلبية', category: 'حسن التعامل', severity: 'عالية' })
  });
  assert.equal(positiveCatOnNegative.status, 400);
  const ok = await t.call('POST', '/api/experiences', {
    token: staffToken, body: experience(doc.id, { sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'عالية', visitTime: '23:30' })
  });
  assert.equal(ok.status, 201);
  const row = t.db._store.tables.experiences.find(e => e.id === ok.body.id);
  assert.equal(row.follow_up, 'جديدة');
  assert.equal(row.severity, 'عالية');
});

test('experience: missing survey answers are rejected', async () => {
  for (const k of ['bookingRating', 'receptionRating', 'planExplained', 'doctorRating']) {
    const body = experience(doc.id); delete body[k];
    const r = await t.call('POST', '/api/experiences', { token: staffToken, body });
    assert.equal(r.status, 400, k);
  }
});

test('experience: "لا ينطبق" rejected unless the visit is كشف', async () => {
  const bad = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { planExplained: 'لا ينطبق', visitType: 'إجراء' }) });
  assert.equal(bad.status, 400);
  const ok = await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { planExplained: 'لا ينطبق', visitType: 'كشف' }) });
  assert.equal(ok.status, 201);
});

test('experience: inactive doctor, wrong branch, bad file no and future visits are rejected', async () => {
  const inactive = t.addDoctor({ name: 'د. موقوف', active: false });
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(inactive.id) })).body.error, /الطبيب/);
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(docOnaizah.id) })).body.error, /لا يعمل في هذا الفرع/);
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { fileNo: 'ملف ١' }) })).body.error, /رقم الملف/);
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { phone: '12345' }) })).body.error, /الجوال/);
  assert.match((await t.call('POST', '/api/experiences', { token: staffToken, body: experience(doc.id, { visitDate: '2099-01-01' }) })).body.error, /المستقبل/);
});

test('staff see only their own experiences, with masked phones', async () => {
  await t.call('POST', '/api/experiences', { token: otherToken, body: experience(doc.id, { fileNo: 'OTHER-1' }) });
  const mine = await t.call('GET', '/api/experiences', { token: staffToken });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.rows.length > 0);
  assert.ok(mine.body.rows.every(r => r.fileNo !== 'OTHER-1'));
  assert.ok(mine.body.rows.every(r => r.phone === '' || /^05\*{5}\d{3}$/.test(r.phone)), JSON.stringify(mine.body.rows.map(r => r.phone)));
  assert.ok(mine.body.rows.every(r => r.by === undefined));
  const all = await t.call('GET', '/api/experiences', { token: adminToken });
  assert.ok(all.body.rows.some(r => r.fileNo === 'OTHER-1'));
  assert.ok(all.body.rows.some(r => r.phone === '0551234567'));
  assert.ok(all.body.rows.some(r => r.by === 'noura'));
});

test('experience list filters by hour:minute in Riyadh time and by file number', async () => {
  const late = await t.call('GET', '/api/experiences?timeFrom=23:00&timeTo=23:59', { token: adminToken });
  assert.ok(late.body.rows.length >= 1);
  assert.ok(late.body.rows.every(r => r.visitAt.endsWith('23:30')));
  const day = await t.call('GET', '/api/experiences?from=2026-03-10&to=2026-03-10', { token: adminToken });
  assert.ok(day.body.rows.some(r => r.visitAt === '2026-03-10 23:30'), '23:30 belongs to the same day');
  const file = await t.call('GET', '/api/experiences?fileNo=other', { token: adminToken });
  assert.deepEqual(file.body.rows.map(r => r.fileNo), ['OTHER-1']);
  assert.equal((await t.call('GET', '/api/experiences?timeFrom=12:00&timeTo=08:00', { token: adminToken })).status, 400);
});

test('follow-up: admin only, negative experiences only', async () => {
  const neg = t.db._store.tables.experiences.find(e => e.sentiment === 'سلبية');
  const pos = t.db._store.tables.experiences.find(e => e.sentiment === 'إيجابية');
  assert.equal((await t.call('PATCH', `/api/experiences/${neg.id}/follow-up`, { token: staffToken, body: { followUp: 'مغلقة' } })).status, 403);
  assert.match((await t.call('PATCH', `/api/experiences/${pos.id}/follow-up`, { token: adminToken, body: { followUp: 'مغلقة' } })).body.error, /السلبية فقط/);
  assert.equal((await t.call('PATCH', `/api/experiences/${neg.id}/follow-up`, { token: adminToken, body: { followUp: 'مغلقة' } })).status, 200);
  assert.equal(neg.follow_up, 'مغلقة');
});

test('staff cannot see KPIs or admin endpoints', async () => {
  assert.equal((await t.call('GET', '/api/kpis', { token: staffToken })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/users', { token: staffToken })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/doctors', { token: staffToken, body: { name: 'x', specialty: 'أسنان', branch: 'بريدة' } })).status, 403);
});

test('complaints: staff add, admin handles; closed_at set on close and cleared on reopen', async () => {
  const add = await t.call('POST', '/api/complaints', {
    token: staffToken, body: { fileNo: 'C-1', phone: '0559876543', branch: 'بريدة', doctorId: doc.id, category: 'التكلفة والأسعار', description: 'الفاتورة أعلى من المتفق عليه' }
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const list = await t.call('GET', '/api/complaints', { token: staffToken });
  const c = list.body.rows.find(x => x.id === add.body.id);
  assert.equal(c.phone, '05*****543');
  assert.equal(c.doctor, doc.name);
  assert.equal(c.source, 'إدخال يدوي');
  assert.equal(list.body.summary.open >= 1, true);

  assert.equal((await t.call('PATCH', `/api/complaints/${c.id}`, { token: staffToken, body: { status: 'مغلقة' } })).status, 403);
  const close = await t.call('PATCH', `/api/complaints/${c.id}`, { token: adminToken, body: { status: 'مغلقة', assignedTo: 'مشرفة الجودة', resolution: 'تم تعديل الفاتورة' } });
  assert.equal(close.status, 200);
  const stored = t.db._store.tables.complaints.find(x => x.id === c.id);
  assert.ok(stored.closed_at);
  const firstClose = stored.closed_at;
  await t.call('PATCH', `/api/complaints/${c.id}`, { token: adminToken, body: { status: 'مغلقة', resolution: 'تحديث' } });
  assert.equal(stored.closed_at, firstClose, 'closing again keeps the original close time');
  await t.call('PATCH', `/api/complaints/${c.id}`, { token: adminToken, body: { status: 'قيد المعالجة' } });
  assert.equal(stored.closed_at, null);
});

test('complaints: overdue flag after OVERDUE_DAYS', async () => {
  t.db._store.tables.complaints.push({
    id: require('node:crypto').randomUUID(), created_at: new Date(Date.now() - 5 * 86400000).toISOString(), file_no: 'OLD-1', phone: null,
    doctor_id: null, doctor_name_raw: null, branch: 'عنيزة', category: null, severity: 'عالية', status: 'جديدة', description: 'قديمة',
    source: 'إدخال يدوي', source_key: null, assigned_to: null, resolution: null, closed_at: null, updated_by: null
  });
  const r = await t.call('GET', '/api/complaints', { token: adminToken });
  assert.equal(r.body.rows.find(x => x.fileNo === 'OLD-1').overdue, true);
  assert.ok(r.body.summary.overdue >= 1);
});

test('webhook: wrong or missing secret → 401', async () => {
  const body = { rows: [{ source_key: 'k1', description: 'x' }] };
  assert.equal((await t.call('POST', '/api/webhooks/complaints', { body })).status, 401);
  assert.equal((await t.call('POST', '/api/webhooks/complaints', { body, headers: { 'x-webhook-secret': 'wrong' } })).status, 401);
});

test('webhook: idempotent on source_key, matches doctors, never stores patient names', async () => {
  const headers = { 'x-webhook-secret': 'hook-secret' };
  const rows = [
    { source_key: 'sheet1:Form:2', date: '2026-03-15T09:00:00+03:00', file_no: 'F-77', phone: '966551112222', doctor: 'الدكتورة سارة العتيبي',
      branch: 'بريدة', category: 'أسلوب التعامل', severity: 'عالية', description: 'لم يتم الرد على استفساري',
      patient_name: 'محمد أحمد', 'اسم المريض': 'محمد أحمد' },
    { source_key: 'sheet1:Form:3', doctor: 'د. غير معروف', phone: '123', severity: 'كارثية', branch: 'جدة', description: 'انتظار طويل' },
    { source_key: 'sheet1:Form:4', description: '' }
  ];
  const first = await t.call('POST', '/api/webhooks/complaints', { headers, body: { rows } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.inserted, 2);
  const again = await t.call('POST', '/api/webhooks/complaints', { headers, body: { rows } });
  assert.equal(again.body.inserted, 0);
  const stored = t.db._store.tables.complaints.filter(c => c.source_key && c.source_key.startsWith('sheet1:'));
  assert.equal(stored.length, 2);

  const a = stored.find(c => c.source_key === 'sheet1:Form:2');
  assert.equal(a.doctor_id, doc.id, 'title-insensitive doctor match');
  assert.equal(a.doctor_name_raw, null);
  assert.equal(a.phone, '0551112222');
  assert.equal(a.severity, 'عالية');
  assert.equal(a.created_at, '2026-03-15T06:00:00.000Z');
  assert.equal(a.source, 'شيت الشكاوى');

  const b = stored.find(c => c.source_key === 'sheet1:Form:3');
  assert.equal(b.doctor_id, null);
  assert.equal(b.doctor_name_raw, 'د. غير معروف');
  assert.equal(b.phone, null, 'invalid phone dropped');
  assert.equal(b.severity, 'متوسطة');
  assert.equal(b.branch, null);

  const dump = JSON.stringify(t.db._store.tables);
  assert.equal(dump.includes('محمد أحمد'), false, 'patient name must not be stored anywhere');

  // An admin's handling must survive a re-send of the same row.
  await t.call('PATCH', `/api/complaints/${a.id}`, { token: adminToken, body: { status: 'مغلقة', resolution: 'تم التواصل' } });
  await t.call('POST', '/api/webhooks/complaints', { headers, body: { rows } });
  assert.equal(a.status, 'مغلقة');
});

test('webhook: rejects oversized batches and malformed bodies', async () => {
  const headers = { 'x-webhook-secret': 'hook-secret' };
  const many = Array.from({ length: 101 }, (_, i) => ({ source_key: `bulk:${i}`, description: 'x' }));
  assert.equal((await t.call('POST', '/api/webhooks/complaints', { headers, body: { rows: many } })).status, 400);
  assert.equal((await t.call('POST', '/api/webhooks/complaints', { headers, body: { nope: 1 } })).status, 400);
});

test('KPIs endpoint returns per-doctor ratings, branches and distributions', async () => {
  const r = await t.call('GET', '/api/kpis', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k = r.body.kpis;
  assert.ok(k.summary.total >= 4);
  const d = k.doctors.find(x => x.id === doc.id);
  assert.equal(d.name, doc.name);
  assert.equal(d.avgDoctor, 5);
  assert.ok(k.doctors.some(x => x.id === docOnaizah.id), 'active doctors without data are listed');
  assert.ok(k.branches.find(b => b.branch === 'بريدة').avgBooking > 0);
  assert.equal(k.ratingDistribution.doctor.length, 5);
  assert.equal(k.heatmap.length, 7);
  assert.ok(k.topProblems.experiences.some(p => p.name === 'وقت الانتظار'));

  const filtered = await t.call('GET', '/api/kpis?branch=عنيزة', { token: adminToken });
  assert.equal(filtered.body.kpis.summary.total, 0);
  assert.ok(!filtered.body.kpis.doctors.some(x => x.id === doc.id));
  const late = await t.call('GET', '/api/kpis?timeFrom=23:00&timeTo=23:59', { token: adminToken });
  assert.equal(late.body.kpis.summary.total, late.body.kpis.byHour[23].total);
});

test('admin: create user returns a temp password once; reset works; cannot demote self', async () => {
  const create = await t.call('POST', '/api/admin/users', { token: adminToken, body: { username: 'New.Staff', name: 'موظفة جديدة', role: 'staff', branch: 'عنيزة' } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.row.username, 'new.staff');
  assert.match(create.body.tempPassword, /^[A-Za-z0-9]{10}$/);
  assert.equal(create.body.row.password_hash, undefined, 'hash never leaves the server');
  const token = await t.login('new.staff', create.body.tempPassword);
  assert.equal((await t.call('GET', '/api/auth/me', { token })).body.user.mustChange, true);

  const dup = await t.call('POST', '/api/admin/users', { token: adminToken, body: { username: 'new.staff', name: 'x', role: 'staff' } });
  assert.equal(dup.status, 409);

  const list = await t.call('GET', '/api/admin/users', { token: adminToken });
  assert.ok(list.body.rows.every(u => u.password_hash === undefined));

  const reset = await t.call('PATCH', `/api/admin/users/${create.body.row.id}`, { token: adminToken, body: { resetPassword: true } });
  assert.match(reset.body.tempPassword, /^[A-Za-z0-9]{10}$/);
  assert.notEqual(reset.body.tempPassword, create.body.tempPassword);

  assert.match((await t.call('PATCH', `/api/admin/users/${admin.id}`, { token: adminToken, body: { active: false } })).body.error, /لا يمكنك/);
  assert.match((await t.call('PATCH', `/api/admin/users/${admin.id}`, { token: adminToken, body: { role: 'staff' } })).body.error, /لا يمكنك/);
});

test('admin: doctors and categories are added, edited and deactivated (no delete)', async () => {
  const add = await t.call('POST', '/api/admin/doctors', { token: adminToken, body: { name: 'د. ريم', specialty: 'جلدية', branch: 'الكل' } });
  assert.equal(add.status, 201);
  assert.equal((await t.call('POST', '/api/admin/doctors', { token: adminToken, body: { name: 'د. ريم', specialty: 'جلدية', branch: 'الكل' } })).status, 409);
  const off = await t.call('PATCH', `/api/admin/doctors/${add.body.row.id}`, { token: adminToken, body: { active: false } });
  assert.equal(off.body.row.active, false);
  assert.equal((await t.call('DELETE', `/api/admin/doctors/${add.body.row.id}`, { token: adminToken })).status, 404);

  const cat = await t.call('POST', '/api/admin/categories', { token: adminToken, body: { name: 'صعوبة المواقف', type: 'سلبية' } });
  assert.equal(cat.status, 201);
  const edit = await t.call('PATCH', `/api/admin/categories/${cat.body.row.id}`, { token: adminToken, body: { type: 'الكل' } });
  assert.equal(edit.body.row.type, 'الكل');
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'update_category'));
});

test('unknown API routes give JSON 404; other paths serve the app shell', async () => {
  const r = await t.call('GET', '/api/nope', { token: adminToken });
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  const page = await fetch(`${t.base}/some/deep/link`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-/);
  const html = await page.text();
  assert.equal(html.includes('__CSP_NONCE__'), false);
});

test('internal errors do not leak details', async () => {
  const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'صيغة الطلب غير صالحة' });
});

test('health reports a database problem with a 503 and only an error code', async () => {
  const ok = await t.call('GET', '/api/health');
  assert.equal(ok.body.db, 'ok');
  const { startApp } = require('./helpers');
  const broken = await startApp();
  broken.db.from = () => ({ select: () => ({ limit: async () => ({ data: null, error: { code: 'PGRST205', message: 'secret detail' } }) }) });
  const r = await broken.call('GET', '/api/health');
  await broken.close();
  assert.equal(r.status, 503);
  assert.equal(r.body.db, 'error:categories:PGRST205');
  assert.equal(JSON.stringify(r.body).includes('secret detail'), false);
});

test('an admin password reset signs the user out everywhere', async () => {
  const u = t.addUser({ username: 'resetme' });
  const token = await t.login('resetme');
  assert.equal((await t.call('GET', '/api/auth/me', { token })).status, 200);
  await t.call('PATCH', `/api/admin/users/${u.id}`, { token: adminToken, body: { resetPassword: true } });
  assert.equal((await t.call('GET', '/api/auth/me', { token })).status, 401);
});
