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
    officer: { role: 'case_officer' }, qs: { role: 'quality_specialist' }, officer2: { role: 'case_officer' }, staffB: { role: 'staff', branch: 'بريدة' }
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

test('quality specialist: all branches, works and closes cases, sees analytics; no setup, assigning or approving', async () => {
  const me = (await t.call('GET', '/api/auth/me', { token: tok.qs })).body.user;
  assert.equal(me.roleLabel, 'أخصائية الجودة');
  assert.equal(me.scope, null);
  for (const p of ['analytics', 'viewAllExperiences', 'viewCases', 'handleCases', 'fullPhones', 'importCalls', 'record']) assert.ok(me.perms.includes(p), p);
  for (const p of ['manageSetup', 'assignCases', 'approveCases']) assert.ok(!me.perms.includes(p), p);
  assert.equal((await t.call('GET', '/api/admin/users', { token: tok.qs })).status, 403);

  const other = await t.call('POST', '/api/experiences', { token: tok.staffB, body: neg(docU.id, { fileNo: 'QS-1', branch: 'عنيزة' }) });
  const c = caseFor('تجربة سلبية', other.body.id);
  await t.call('POST', `/api/cases/${c.id}/assign`, { token: tok.admin, body: { userId: u.officer.id } });
  assert.ok((await t.call('GET', '/api/cases?status=all', { token: tok.qs })).body.rows.some(r => r.id === c.id), 'sees cases assigned to others');
  const closed = await t.call('POST', `/api/cases/${c.id}/close`, { token: tok.qs, body: { reason: 'تم الاعتذار والتوضيح', resolution: 'تم التواصل' } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(caseFor('تجربة سلبية', other.body.id).status, 'مغلقة');
  assert.equal((await t.call('GET', '/api/kpis', { token: tok.qs })).status, 200);
  const created = await t.call('POST', '/api/admin/users', { token: tok.quality, body: { username: 'qs.new', name: 'أخصائية', role: 'quality_specialist' } });
  assert.equal(created.status, 201);
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

test('editing a recorded experience: who may, and how the follow-up case follows', async () => {
  const mine = await t.call('POST', '/api/experiences', { token: tok.staffB, body: experience(docB.id, { fileNo: 'ED-1', phone: '0551112222' }) });
  const id = mine.body.id;
  const edit = (token, over) => t.call('PATCH', `/api/experiences/${id}`, { token, body: experience(docB.id, { fileNo: 'ED-1', phone: '0551112222', ...over }) });

  // The person who recorded it can fix it; nothing changed means nothing written.
  assert.deepEqual((await edit(tok.staffB, {})).body.changed, []);
  const r1 = await edit(tok.staffB, { doctorRating: 3 });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.changed, ['doctor_rating']);
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'update_experience' && a.details.includes('doctor_rating')));
  const list = (await t.call('GET', '/api/experiences', { token: tok.staffB })).body.rows;
  assert.equal(list.find(x => x.id === id).canEdit, true);

  // Someone else's: no for another receptionist or a manager of another branch; yes for quality.
  assert.equal((await edit(tok.officer, { doctorRating: 4 })).status, 403);
  assert.equal((await edit(tok.bmU, { doctorRating: 4 })).status, 403);
  assert.equal((await edit(tok.qs, { doctorRating: 4 })).status, 200);

  // Becomes negative: a case opens with the new details.
  const toNeg = await edit(tok.qs, { sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'متوسطة', generalNote: 'انتظر ساعة' });
  assert.equal(toNeg.status, 200, JSON.stringify(toNeg.body));
  let c = caseFor('تجربة سلبية', id);
  assert.ok(c, 'case opened');
  assert.equal(c.severity, 'متوسطة');
  assert.match(c.summary, /انتظر ساعة/);

  // Still negative, now high: the open case takes it and logs the change.
  await edit(tok.qs, { sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'عالية', generalNote: 'انتظر ساعة' });
  c = caseFor('تجربة سلبية', id);
  assert.equal(c.severity, 'عالية');
  assert.ok(t.db._store.tables.case_events.some(e => e.case_id === c.id && /عُدّلت التجربة/.test(e.body)));

  // No longer negative: the case stays (someone decides), with a note to review it.
  await edit(tok.qs, { sentiment: 'إيجابية' });
  assert.equal(caseFor('تجربة سلبية', id).status !== 'مغلقة', true);
  assert.ok(t.db._store.tables.case_events.some(e => e.case_id === c.id && /راجع الحالة/.test(e.body)));
  assert.equal(t.db._store.tables.experiences.find(e => e.id === id).follow_up, null);

  // A masked phone in the form is not written back: keepPhone keeps the stored number.
  const kp = await t.call('PATCH', `/api/experiences/${id}`, { token: tok.staffB, body: { ...experience(docB.id, { fileNo: 'ED-1', sentiment: 'إيجابية' }), phone: '', keepPhone: true } });
  assert.equal(kp.status, 200, JSON.stringify(kp.body));
  assert.equal(t.db._store.tables.experiences.find(e => e.id === id).phone, '0551112222');
  assert.equal((await t.call('PATCH', '/api/experiences/00000000-0000-4000-8000-000000000000', { token: tok.qs, body: experience(docB.id) })).status, 404);
});

test('roles screen: change who can do what, effective at once; admin keeps everything; reset to defaults', async () => {
  assert.equal((await t.call('GET', '/api/admin/roles', { token: tok.staffB })).status, 403);
  const g = await t.call('GET', '/api/admin/roles', { token: tok.admin });
  assert.equal(g.status, 200);
  assert.ok(g.body.perms.some(p => p.key === 'analytics' && p.label));
  assert.ok(g.body.roles.find(r => r.key === 'admin').locked);
  const table = g.body.current;

  // Give reception the analytics; take case handling from the quality specialist; stop limiting branch managers to a branch.
  assert.equal((await t.call('GET', '/api/kpis', { token: tok.staffB })).status, 403);
  const next = JSON.parse(JSON.stringify(table));
  next.perms.analytics.push('staff');
  next.perms.handleCases = next.perms.handleCases.filter(r => r !== 'quality_specialist');
  next.perms.manageSetup = ['quality'];
  next.branchScoped = next.branchScoped.filter(r => r !== 'branch_manager');
  const put = await t.call('PUT', '/api/admin/roles', { token: tok.quality, body: next });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.ok(put.body.current.perms.manageSetup.includes('admin'), 'admin always keeps the admin screen');
  assert.equal((await t.call('GET', '/api/kpis', { token: tok.staffB })).status, 200);
  const me = (await t.call('GET', '/api/auth/me', { token: tok.qs })).body.user;
  assert.ok(!me.perms.includes('handleCases'));
  assert.equal((await t.call('GET', '/api/auth/me', { token: tok.bmB })).body.user.scope, null);
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'update_role_perms'));

  // A quality manager cannot take the admin screen away from their own role.
  const lock = JSON.parse(JSON.stringify(put.body.current));
  lock.perms.manageSetup = [];
  const bad = await t.call('PUT', '/api/admin/roles', { token: tok.quality, body: lock });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /الإدارة/);
  assert.equal((await t.call('PUT', '/api/admin/roles', { token: tok.quality, body: { perms: 'x' } })).status, 400);

  // Back to the defaults.
  const reset = await t.call('POST', '/api/admin/roles/reset', { token: tok.admin });
  assert.equal(reset.status, 200);
  assert.equal((await t.call('GET', '/api/kpis', { token: tok.staffB })).status, 403);
  assert.equal((await t.call('GET', '/api/auth/me', { token: tok.bmB })).body.user.scope, 'بريدة');
});
