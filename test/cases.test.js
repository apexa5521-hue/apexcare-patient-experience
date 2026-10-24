'use strict';

// Roles, branch scoping and the follow-up case workflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, experience } = require('./helpers');

let t, tok = {}, u = {}, docB, docU;

const neg = (doctorId, over = {}) => experience(doctorId, { sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'بسيطة', ...over });
const caseFor = (source, id) => t.db._store.tables.cases.find(c => c.source === source && c.source_id === id);

test.before(async () => {
  t = await startApp();
  docB = t.addDoctor({ name: 'Dr. B', branch: 'بريدة' });
  docU = t.addDoctor({ name: 'Dr. U', branch: 'عنيزة' });
  const people = {
    admin: { role: 'admin' }, quality: { role: 'quality' }, ops: { role: 'operations' }, exec: { role: 'executive' },
    bmB: { role: 'branch_manager', branch: 'بريدة' }, bmU: { role: 'branch_manager', branch: 'عنيزة' },
    officer: { role: 'case_officer' }, officer2: { role: 'case_officer' }, staffB: { role: 'staff', branch: 'بريدة' }
  };
  for (const [k, v] of Object.entries(people)) u[k] = t.addUser({ username: `u.${k.toLowerCase()}`, name: `اسم ${k}`, ...v });
  for (const k of Object.keys(people)) tok[k] = await t.login(`u.${k.toLowerCase()}`);
});
test.after(() => t.close());

test('me returns role label, permissions and branch scope', async () => {
  const me = (await t.call('GET', '/api/auth/me', { token: tok.bmB })).body.user;
  assert.equal(me.roleLabel, 'مدير فرع');
  assert.equal(me.scope, 'بريدة');
  assert.ok(me.perms.includes('analytics') && me.perms.includes('approveCases'));
  assert.ok(!me.perms.includes('manageSetup'));
  const ex = (await t.call('GET', '/api/auth/me', { token: tok.exec })).body.user;
  assert.ok(ex.perms.includes('analytics') && ex.perms.includes('viewCases'));
  assert.ok(!ex.perms.includes('handleCases') && !ex.perms.includes('record'));
});

test('user admin: branch managers need a branch; only quality/admin manage users', async () => {
  const bad = await t.call('POST', '/api/admin/users', { token: tok.quality, body: { username: 'bm.x', name: 'x', role: 'branch_manager' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /فرع/);
  const ok = await t.call('POST', '/api/admin/users', { token: tok.quality, body: { username: 'bm.x', name: 'x', role: 'branch_manager', branch: 'بريدة' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.row.roleLabel, 'مدير فرع');
  assert.equal((await t.call('PATCH', `/api/admin/users/${ok.body.row.id}`, { token: tok.quality, body: { branch: '' } })).status, 400);
  assert.equal((await t.call('GET', '/api/admin/users', { token: tok.ops })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/users', { token: tok.bmB })).status, 403);
  assert.match((await t.call('PATCH', `/api/admin/users/${u.quality.id}`, { token: tok.quality, body: { role: 'staff' } })).body.error, /دورك/);
});

test('executive reads but cannot record or act', async () => {
  assert.equal((await t.call('POST', '/api/experiences', { token: tok.exec, body: neg(docB.id) })).status, 403);
  assert.equal((await t.call('POST', '/api/complaints', { token: tok.exec, body: { fileNo: 'X1', branch: 'بريدة', description: 'x' } })).status, 403);
  assert.equal((await t.call('GET', '/api/kpis', { token: tok.exec })).status, 200);
  assert.equal((await t.call('GET', '/api/cases', { token: tok.exec })).status, 200);
});

test('full workflow: open → claim by acting → contact → close; high severity needs approval', async () => {
  const low = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docB.id, { fileNo: 'WF-1', phone: '0551234567' }) });
  const high = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docB.id, { fileNo: 'WF-2', severity: 'عالية' }) });
  const cLow = caseFor('تجربة سلبية', low.body.id), cHigh = caseFor('تجربة سلبية', high.body.id);
  assert.ok(cLow && cHigh);
  assert.equal(Math.round((new Date(cHigh.due_at) - new Date(cHigh.created_at)) / 3600000), 24, 'high = 24h SLA');
  assert.equal(Math.round((new Date(cLow.due_at) - new Date(cLow.created_at)) / 3600000), 72, 'low = 72h SLA');

  // officer sees unassigned cases with full phone; executive sees masked phone
  const offList = await t.call('GET', '/api/cases', { token: tok.officer });
  const row = offList.body.rows.find(r => r.id === cLow.id);
  assert.equal(row.phone, '0551234567');
  assert.equal((await t.call('GET', '/api/cases', { token: tok.exec })).body.rows.find(r => r.id === cLow.id).phone, '05*****567');

  // validation of contact log
  assert.equal((await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.officer, body: { type: 'اتصال' } })).status, 400);
  assert.equal((await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.officer, body: { type: 'ملاحظة', body: '' } })).status, 400);
  assert.equal((await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.exec, body: { type: 'ملاحظة', body: 'x' } })).status, 403);

  // first contact: auto-claims, records first response, moves to in-progress
  const call = await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.officer, body: { type: 'اتصال', outcome: 'لم يرد' } });
  assert.equal(call.status, 201, JSON.stringify(call.body));
  assert.equal(cLow.assigned_to, u.officer.id);
  assert.ok(cLow.first_response_at);
  assert.equal(cLow.status, 'قيد المعالجة');
  assert.equal(t.db._store.tables.experiences.find(e => e.id === low.body.id).follow_up, 'قيد المعالجة', 'mirrored to the experience');

  // another officer can no longer see or act on it
  assert.equal((await t.call('GET', `/api/cases/${cLow.id}`, { token: tok.officer2 })).status, 404);
  assert.ok(!(await t.call('GET', '/api/cases', { token: tok.officer2 })).body.rows.some(r => r.id === cLow.id));

  await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.officer, body: { type: 'واتساب', outcome: 'أُرسلت رسالة', body: 'أرسلنا اعتذاراً' } });
  await t.call('POST', `/api/cases/${cLow.id}/status`, { token: tok.officer, body: { status: 'بانتظار المريض' } });
  assert.equal(cLow.status, 'بانتظار المريض');
  assert.equal((await t.call('POST', `/api/cases/${cLow.id}/close`, { token: tok.officer, body: { reason: 'سبب وهمي', resolution: 'x' } })).status, 400);
  const closeLow = await t.call('POST', `/api/cases/${cLow.id}/close`, { token: tok.officer, body: { reason: 'تم الاعتذار والتوضيح', resolution: 'اعتذرنا وشرحنا سبب التأخير' } });
  assert.equal(closeLow.body.status, 'مغلقة', 'low severity closes directly');
  assert.equal(t.db._store.tables.experiences.find(e => e.id === low.body.id).follow_up, 'مغلقة');
  assert.match((await t.call('POST', `/api/cases/${cLow.id}/events`, { token: tok.officer, body: { type: 'ملاحظة', body: 'x' } })).body.error, /مغلقة/);

  // high severity: officer requests, branch manager of another branch can't approve, own branch manager returns then approves
  const req1 = await t.call('POST', `/api/cases/${cHigh.id}/close`, { token: tok.officer, body: { reason: 'تم الحل', resolution: 'تمت إعادة الإجراء' } });
  assert.equal(req1.body.status, 'بانتظار الاعتماد');
  const detail = (await t.call('GET', `/api/cases/${cHigh.id}`, { token: tok.bmB })).body;
  assert.equal(detail.can.approve, true);
  assert.ok(detail.events.some(e => e.body.includes('طلب إقفال')));
  assert.equal((await t.call('POST', `/api/cases/${cHigh.id}/approve`, { token: tok.bmU, body: { approve: true } })).status, 404, 'other branch: not even visible');
  assert.equal((await t.call('POST', `/api/cases/${cHigh.id}/approve`, { token: tok.officer, body: { approve: true } })).status, 403);
  assert.match((await t.call('POST', `/api/cases/${cHigh.id}/approve`, { token: tok.bmB, body: { approve: false } })).body.error, /سبب/);
  await t.call('POST', `/api/cases/${cHigh.id}/approve`, { token: tok.bmB, body: { approve: false, note: 'اتصل بالمريض أولاً' } });
  assert.equal(cHigh.status, 'قيد المعالجة');
  await t.call('POST', `/api/cases/${cHigh.id}/events`, { token: tok.officer, body: { type: 'اتصال', outcome: 'تم التواصل', body: 'المريض راضٍ' } });
  await t.call('POST', `/api/cases/${cHigh.id}/close`, { token: tok.officer, body: { reason: 'تم الحل', resolution: 'تم التواصل والحل' } });
  const ok = await t.call('POST', `/api/cases/${cHigh.id}/approve`, { token: tok.bmB, body: { approve: true } });
  assert.equal(ok.status, 200);
  assert.equal(cHigh.status, 'مغلقة');
  assert.equal(cHigh.approved_by, 'u.bmb');

  // managers close high severity directly
  const h2 = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docB.id, { fileNo: 'WF-3', severity: 'عالية' }) });
  const c2 = caseFor('تجربة سلبية', h2.body.id);
  assert.equal((await t.call('POST', `/api/cases/${c2.id}/close`, { token: tok.ops, body: { reason: 'غير مبررة', resolution: 'راجعنا السجل' } })).body.status, 'مغلقة');
  assert.equal(c2.assigned_to, u.ops.id, 'closing an unassigned case attributes it to the closer');
  const h3 = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docB.id, { fileNo: 'WF-4' }) });
  const c3 = caseFor('تجربة سلبية', h3.body.id);
  await t.call('POST', `/api/cases/${c3.id}/events`, { token: tok.bmB, body: { type: 'ملاحظة', body: 'للاطلاع' } });
  assert.equal(c3.assigned_to, null, 'a manager note does not take the case');
  await t.call('POST', `/api/cases/${c3.id}/events`, { token: tok.bmB, body: { type: 'اتصال', outcome: 'لم يرد' } });
  assert.equal(c3.assigned_to, u.bmB.id, 'contacting the patient does');
});

test('assignment: managers assign to people who can handle cases', async () => {
  const e = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docB.id, { fileNo: 'AS-1' }) });
  const c = caseFor('تجربة سلبية', e.body.id);
  assert.equal((await t.call('POST', `/api/cases/${c.id}/assign`, { token: tok.officer, body: { userId: u.officer.id } })).status, 403);
  assert.match((await t.call('POST', `/api/cases/${c.id}/assign`, { token: tok.bmB, body: { userId: u.staffB.id } })).body.error, /صلاحية المتابعة/);
  assert.equal((await t.call('POST', `/api/cases/${c.id}/assign`, { token: tok.bmB, body: { userId: u.officer2.id } })).status, 200);
  assert.equal(c.assigned_to, u.officer2.id);
  const mine = await t.call('GET', '/api/cases?assigned=me', { token: tok.officer2 });
  assert.ok(mine.body.rows.some(r => r.id === c.id && r.mine));
  const people = (await t.call('GET', '/api/cases/assignees', { token: tok.bmB })).body.rows.map(r => r.name);
  assert.ok(people.includes('اسم officer2') && !people.includes('اسم staffB') && !people.includes('اسم exec'));
});

test('branch managers only see their branch: cases, complaints, experiences, KPIs', async () => {
  await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docU.id, { fileNo: 'UN-1', branch: 'عنيزة' }) });
  await t.call('POST', '/api/complaints', { token: tok.staffB, body: { fileNo: 'UN-2', branch: 'عنيزة', description: 'في عنيزة' } });
  const cases = (await t.call('GET', '/api/cases?status=all', { token: tok.bmB })).body.rows;
  assert.ok(cases.length && cases.every(c => c.branch === 'بريدة' || c.branch === ''));
  const other = t.db._store.tables.cases.find(c => c.file_no === 'UN-1');
  assert.equal((await t.call('GET', `/api/cases/${other.id}`, { token: tok.bmB })).status, 404);
  assert.ok((await t.call('GET', '/api/complaints', { token: tok.bmB })).body.rows.every(c => c.branch === 'بريدة'));
  assert.ok((await t.call('GET', '/api/experiences', { token: tok.bmB })).body.rows.every(e => e.branch === 'بريدة'));
  const k = (await t.call('GET', `/api/kpis?branch=${encodeURIComponent('عنيزة')}`, { token: tok.bmB })).body.kpis;
  assert.ok(k.branches.every(b => b.branch === 'بريدة'), 'branch filter is forced to their own');
  assert.ok((await t.call('GET', '/api/cases', { token: tok.bmU })).body.rows.some(c => c.fileNo === 'UN-1'));
});

test('case stats: volume, response and close times, on-time rate, workload', async () => {
  const s = (await t.call('GET', '/api/cases/stats', { token: tok.quality })).body.stats;
  assert.ok(s.total >= 6);
  assert.ok(s.closed >= 3);
  assert.equal(typeof s.avgFirstResponseH, 'number');
  assert.equal(typeof s.avgCloseH, 'number');
  assert.equal(s.onTimePct, 100);
  assert.ok(s.bySource.some(x => x.key === 'تجربة سلبية'));
  assert.ok(s.closeReasons.some(x => x.key === 'تم الحل'));
  const off = s.assignees.find(a => a.id === u.officer.id);
  assert.ok(off.closed >= 2);
  const bm = (await t.call('GET', '/api/cases/stats', { token: tok.bmU })).body.stats;
  assert.ok(bm.byBranch.every(b => b.key === 'عنيزة' || b.key === ''));
});
