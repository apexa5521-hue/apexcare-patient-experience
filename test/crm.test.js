'use strict';

// CRM patient export: column mapping, targeted visits → call list, file-opening quality, daily minimum per employee.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startApp, experience } = require('./helpers');
const C = require('../server/crm');

const HEADERS = ['#', 'الإسم الأول', 'إسم العائلة', 'رقم الملف', 'رقم الهاتف', 'رقم الهاتف صحيح', 'رقم الهوية الوطنية', 'تاريخ الميلاد صحيح',
  'طبيب', 'الفرع', 'تم الإنشاء', 'تم الإنشاء بواسطة', 'آخر موعد Date', 'آخر موعد Status', 'آخر موعد Room'];
// Excel keeps dates without a time zone: written as UTC parts, read back as the same wall-clock time.
const at = (s) => new Date(`${s}:00Z`);
const ROWS = [
  // name ar, name en, file, phone, id, birth ok, doctor, branch, created, by, appt, status
  ['سارة محمد علي الحربي', 'Sara Mohammed Ali Alharbi', '1001', '0551000001', '1012345678', 'صحيح', 'د.عادل الحربي', 'عيادات ايبكس كير | بريدة', '2026-09-01 10:00', 'روان', '2026-09-21 10:30', 'مكتمل'],
  ['نورة سعد', 'Noura Saad', '1002', '0551000002', '12345', 'صحيح', 'د.عادل الحربي', 'عيادات ايبكس كير | بريدة', '2026-09-02 11:00', 'روان', '2026-09-21 11:00', 'مكتمل'],
  ['هند علي محمد السالم', 'Hind Ali Mohammed Alsalem', '1003', '0551000003', '2123456789', 'خطأ', 'عيادة البشرة', 'عيادات ايبكس كير | بريدة', '2026-09-03 12:00', 'عبير', '2026-09-21 18:00', 'مكتمل'],
  ['ريم خالد فهد العتيبي', 'Reem Khalid Fahad Alotaibi', '1004', '0551000004', '1098765432', 'صحيح', 'عيادة البشرة', 'عيادات ايبكس كير | عنيزة', '2026-09-04 13:00', 'عبير', '2026-09-21 19:00', 'مكتمل'],
  ['لمى عبدالله سعد القحطاني', 'Lama Abdullah Saad Alqahtani', '1005', '0551000005', '1011111111', 'صحيح', 'د.عادل الحربي', 'عيادات ايبكس كير | بريدة', '2026-09-05 14:00', 'عبير', '2026-09-21 20:00', 'محجوز'],
  ['منى سالم ناصر الدوسري', 'Mona Salem Nasser Aldosari', '1006', '0551000006', '1022222222', 'صحيح', 'د.عادل الحربي', 'عيادات ايبكس كير | بريدة', '2026-09-06 15:00', '', '2026-09-20 10:00', 'مكتمل']
];

async function xlsx(rows = ROWS) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(HEADERS);
  rows.forEach((r, i) => ws.addRow([i + 1, r[0], r[1], r[2], r[3], 'صحيح', r[4], r[5], r[6], r[7], at(r[8]), r[9], at(r[10]), r[11], 'Clinic8']));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let t, tok = {}, adel, skin;
const upload = (token, buf, date = '2026-09-21') => fetch(`${t.base}/api/crm/upload?date=${date}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'export.xlsx' }, body: buf
}).then(async r => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  t = await startApp();
  adel = t.addDoctor({ name: 'Dr. Adel Al-Harbi', specialty: 'تقويم', branch: 'الكل' }); adel.name_ar = 'عادل الحربي';
  skin = t.addDoctor({ name: 'عيادة بشرة', specialty: 'جلدية', branch: 'الكل' }); skin.name_ar = 'عيادة بشرة';
  for (const [k, role] of [['admin', 'admin'], ['quality', 'quality'], ['qs', 'quality_specialist'], ['staff', 'staff']]) {
    t.addUser({ username: `u.${k}`, name: `اسم ${k}`, role });
    tok[k] = await t.login(`u.${k}`);
  }
});
test.after(() => t.close());

test('columns are found by header name, and a pinned header wins', () => {
  const map = C.mapColumns(HEADERS, {});
  assert.equal(HEADERS[map.fileNo], 'رقم الملف');
  assert.equal(HEADERS[map.phone], 'رقم الهاتف', 'not «رقم الهاتف صحيح»');
  assert.equal(HEADERS[map.createdAt], 'تم الإنشاء', 'not «تم الإنشاء بواسطة»');
  assert.equal(HEADERS[map.createdBy], 'تم الإنشاء بواسطة');
  assert.equal(HEADERS[C.mapColumns(HEADERS, { doctor: 'آخر موعد Room' }).doctor], 'آخر موعد Room');
});

test('ID and name rules match the v4 file checker', () => {
  assert.equal(C.validId('1012345678'), true);
  assert.equal(C.validId('101234567'), false, 'national ID needs 10 digits');
  assert.equal(C.validId('2123456789'), true);
  assert.equal(C.validId('٢١٢٣٤٥٦٧٨٩'), true, 'Arabic digits');
  assert.equal(C.validId('12a'), false);
  const map = C.mapColumns(HEADERS, {});
  const row = ['1', 'نورة سعد', 'Noura Saad', '1002', '0551', 'صحيح', '12345', 'لا', 'د', 'ب', '', '', '', '', ''];
  assert.deepEqual(C.rowErrors(row, map, C.DEFAULT_SETTINGS.rules), ['creator_empty', 'name_ar_short', 'name_en_short', 'id_invalid', 'birth_unchecked']);
  assert.deepEqual(C.rowErrors(row, map, { nameArQuad: false, nameEnQuad: false, idNumber: false, birthDateOk: false }), ['creator_empty'], 'rules can be switched off');
});

test('upload: targets completed visits of the day, suggests doctors, saves quality without names or IDs', async () => {
  assert.equal((await upload(tok.staff, await xlsx())).status, 403, 'reception cannot import');
  const r = await upload(tok.qs, await xlsx());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rows, 6);
  assert.equal(r.body.targets, 4, 'completed on 2026-09-21 only (not «محجوز», not another day)');
  assert.deepEqual(r.body.groups.map(g => [g.crm, g.count, g.doctorId]), [['د.عادل الحربي', 2, adel.id], ['عيادة البشرة', 2, skin.id]]);
  assert.equal(r.body.mapping.phone, 'رقم الهاتف');
  assert.ok(r.body.quality.runId);

  const stored = JSON.stringify(t.db._store.tables);
  for (const secret of ['سارة محمد علي الحربي', 'Noura Saad', '1012345678', '2123456789']) assert.equal(stored.includes(secret), false, `${secret} must not be stored`);

  const run = (await t.call('GET', `/api/crm/quality/runs/${r.body.quality.runId}`, { token: tok.quality })).body.run;
  assert.equal(run.total, 6);
  assert.equal(run.complete, 3);
  const rawan = run.staff.find(s => s.creator === 'روان');
  assert.deepEqual([rawan.total, rawan.complete, rawan.rate], [2, 1, 50]);
  assert.deepEqual(run.errors.find(e => e.fileNo === '1002').codes, ['name_ar_short', 'name_en_short', 'id_invalid']);
  assert.deepEqual(run.errors.find(e => e.fileNo === '1003').codes, ['birth_unchecked']);
  assert.equal(run.errors.find(e => e.fileNo === '1006').creator, 'غير محدد');
  assert.equal((await t.call('GET', '/api/crm/quality/runs', { token: tok.staff })).status, 403);
  assert.equal((await t.call('GET', '/api/crm/quality/runs', { token: tok.qs })).body.rows.length, 1);
});

test('build the list: random sample from the chosen doctors only, links remembered, branch from the file', async () => {
  const up = (await upload(tok.qs, await xlsx())).body;
  const r = await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: up.token, picks: [{ crm: 'عيادة البشرة', doctorId: skin.id }], count: 5 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.pool, r.body.picked, r.body.inserted], [2, 2, 2]);
  const q = t.db._store.tables.call_queue.filter(c => ['1003', '1004'].includes(c.file_no));
  assert.equal(q.length, 2);
  assert.ok(q.every(c => c.doctor_id === skin.id));
  assert.deepEqual(q.map(c => c.branch).sort(), ['بريدة', 'عنيزة']);
  assert.equal(t.db._store.tables.call_queue.some(c => c.file_no === '1001'), false, 'not picked');
  const again = await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: up.token, picks: [{ crm: 'عيادة البشرة', doctorId: skin.id }], count: 5 } });
  assert.equal(again.body.inserted, 0, 'no duplicates');
  const s = (await t.call('GET', '/api/crm/settings', { token: tok.qs })).body.settings;
  assert.equal(s.doctorMap['عيادة البشرة'], skin.id);
  assert.equal((await t.call('POST', '/api/crm/build-list', { token: tok.quality, body: { token: up.token, picks: [{ crm: 'x' }] } })).status, 410, 'an upload is only for whoever uploaded it');
  assert.equal((await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: 'nope', picks: [{ crm: 'x' }] } })).status, 410);
});

test('settings: only admins change them; values are kept within bounds', async () => {
  assert.equal((await t.call('PUT', '/api/crm/settings', { token: tok.qs, body: {} })).status, 403);
  const r = await t.call('PUT', '/api/crm/settings', { token: tok.quality, body: { dailyMinPerStaff: 2, listSize: 9999, completedStatuses: ['مكتمل', ' Completed '], rules: { idNumber: false }, columns: { doctor: 'آخر موعد Room', bogus: 'x' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.dailyMinPerStaff, 2);
  assert.equal(r.body.settings.listSize, 40, 'out of range → default');
  assert.deepEqual(r.body.settings.completedStatuses, ['مكتمل', 'Completed']);
  assert.equal(r.body.settings.rules.idNumber, false);
  assert.deepEqual(r.body.settings.columns, { doctor: 'آخر موعد Room' });
  await t.call('PUT', '/api/crm/settings', { token: tok.quality, body: { dailyMinPerStaff: 2 } });
});

test('daily minimum per employee: progress, alert threshold and the today report', async () => {
  const doc = t.addDoctor({ name: 'Dr. Calls', branch: 'الكل' });
  let p = (await t.call('GET', '/api/calls/progress', { token: tok.staff })).body;
  assert.deepEqual([p.done, p.target, p.met], [0, 2, false]);
  for (let i = 0; i < 2; i++) {
    await t.call('POST', '/api/experiences', { token: tok.staff, body: experience(doc.id, { fileNo: `T-${i}`, channel: 'اتصال', visitDate: '2026-03-10' }) });
  }
  await t.call('POST', '/api/experiences', { token: tok.staff, body: experience(doc.id, { fileNo: 'T-in', channel: 'حضوري', visitDate: '2026-03-10' }) });
  p = (await t.call('GET', '/api/calls/progress', { token: tok.staff })).body;
  assert.deepEqual([p.done, p.met], [2, true], 'in-person ones do not count');

  assert.equal((await t.call('GET', '/api/kpis/today', { token: tok.staff })).status, 403);
  const today = (await t.call('GET', '/api/kpis/today', { token: tok.qs })).body;
  const me = today.staff.find(s => s.username === 'u.staff');
  assert.deepEqual([me.done, me.target, me.met, me.pct], [2, 2, true, 100]);
  assert.equal(today.totals.staffMet >= 1, true);
  assert.equal(today.staff.some(s => s.username === 'u.admin'), false, 'system admin is not a caller');
});

test('assignment: the list is split between the chosen employees; each sees hers and the unassigned; choices are remembered', async () => {
  const a = t.addUser({ username: 'u.rawan', name: 'روان', role: 'staff' }), b = t.addUser({ username: 'u.abeer', name: 'عبير', role: 'staff' });
  const [ta, tb] = [await t.login('u.rawan'), await t.login('u.abeer')];
  const rows = Array.from({ length: 6 }, (_, i) => ['هند علي محمد السالم', 'Hind Ali Mohammed Alsalem', `20${i}`, `05520000${i}0`, '1012345678', 'صحيح', 'د.عادل الحربي', 'عيادات ايبكس كير | بريدة', '2026-09-01 10:00', 'روان', '2026-09-22 10:30', 'مكتمل']);
  const up = (await upload(tok.qs, await xlsx(rows), '2026-09-22')).body;
  assert.ok(up.callers.some(c => c.id === a.id) && up.callers.some(c => c.id === b.id), 'employees to choose from');
  assert.equal((await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: up.token, picks: [{ crm: 'د.عادل الحربي', doctorId: adel.id }], count: 6, assignees: [a.id, 'x'] } })).status, 200, 'non-ids are ignored');
  t.db._store.tables.call_queue = t.db._store.tables.call_queue.filter(c => !String(c.file_no).startsWith('20'));
  const bad = await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: up.token, picks: [{ crm: 'د.عادل الحربي', doctorId: adel.id }], count: 6, assignees: [adel.id] } });
  assert.equal(bad.status, 400, 'only employees with the call list');
  const r = await t.call('POST', '/api/crm/build-list', { token: tok.qs, body: { token: up.token, picks: [{ crm: 'د.عادل الحربي', doctorId: adel.id }], count: 6, assignees: [a.id, b.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.perAssignee[a.id], r.body.perAssignee[b.id]], [3, 3], 'split evenly');

  const mineA = (await t.call('GET', '/api/calls', { token: ta })).body;
  assert.ok(mineA.rows.filter(x => String(x.fileNo).startsWith('20')).every(x => x.assignedTo === a.id));
  assert.equal(mineA.rows.filter(x => String(x.fileNo).startsWith('20')).length, 3);
  assert.ok(mineA.rows.some(x => x.assignedTo === null), 'unassigned visits stay visible to everyone');
  assert.deepEqual(mineA.callers, [], 'employees do not get the list of colleagues');
  const all = (await t.call('GET', '/api/calls', { token: tok.qs })).body;
  assert.equal(all.rows.filter(x => String(x.fileNo).startsWith('20')).length, 6, 'managers see every assignment');
  assert.equal((await t.call('GET', `/api/calls?assignee=${b.id}`, { token: tok.qs })).body.rows.every(x => x.assignedTo === b.id), true);

  // Reassign one of Rawan's to Abeer; employees cannot reassign.
  const one = mineA.rows.find(x => String(x.fileNo).startsWith('20'));
  assert.equal((await t.call('POST', `/api/calls/${one.id}/assign`, { token: ta, body: { userId: b.id } })).status, 403);
  assert.equal((await t.call('POST', `/api/calls/${one.id}/assign`, { token: tok.qs, body: { userId: adel.id } })).status, 400);
  assert.equal((await t.call('POST', `/api/calls/${one.id}/assign`, { token: tok.qs, body: { userId: b.id } })).status, 200);
  assert.equal((await t.call('GET', '/api/calls', { token: tb })).body.rows.filter(x => String(x.fileNo).startsWith('20')).length, 4);

  const s = (await t.call('GET', '/api/crm/settings', { token: tok.qs })).body.settings;
  assert.deepEqual(s.lastPicks, ['د.عادل الحربي']);
  assert.deepEqual(s.lastAssignees, [a.id, b.id]);
  assert.equal(s.listSize, 6, 'the last count becomes the default');
  const next = (await upload(tok.qs, await xlsx(rows), '2026-09-22')).body;
  assert.deepEqual(next.lastAssignees, [a.id, b.id]);
  assert.equal(next.groups.find(g => g.crm === 'د.عادل الحربي').picked, true, 'ticked again on the next upload');

  const today = (await t.call('GET', '/api/kpis/today', { token: tok.qs })).body;
  assert.equal(today.staff.find(x => x.id === b.id).assignedOpen, 4);
});
