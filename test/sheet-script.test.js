'use strict';

// Runs the QR-sheets Apps Script's pure helpers in a sandbox (no Google services).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'qr-sheets', 'Code.gs'), 'utf8');
const sandbox = {};
vm.runInNewContext(src, sandbox);
const { matchHeaders_, time24_ } = sandbox;

test('bilingual Google Form headers map to the right fields; patient name is never used', () => {
  const headers = [
    'Timestamp',
    'Please provide your phone number so we can update you on any action plan\nيرجى تزويدنا برقم جوالك لإطلاعك على أي خطة عمل يتم وضعها بشأن شكواك',
    'TIME OF EVENT\nوقت الحدث',
    'DATE OF EVENT\nتاريخ الحدث',
    'Patient name\nاسم المريض',
    'Describe what happened\nاكتب تفاصيل الشكوى',
    'Branch\nالفرع',
    'Doctor name\nاسم الطبيب',
    'Medical file number\nرقم الملف'
  ];
  const m = matchHeaders_(headers);
  assert.equal(m.date, 3, 'date of event, not the form timestamp');
  assert.equal(m.time, 2);
  assert.equal(m.phone, 1);
  assert.equal(m.description, 5);
  assert.equal(m.branch, 6);
  assert.equal(m.doctor, 7);
  assert.equal(m.file_no, 8);
  assert.ok(!Object.values(m).includes(4), 'patient name column unused');
  assert.ok(!Object.values(m).includes(0), 'timestamp unused when there is an event date');
});

test('plain Arabic headers and timestamp fallback still work', () => {
  const m = matchHeaders_(['الطابع الزمني', 'رقم الملف', 'الجوال', 'الطبيب', 'الشكوى', 'الاسم']);
  assert.equal(m.date, 0);
  assert.equal(m.time, undefined, 'a timestamp is not a time-of-event column');
  assert.equal(m.file_no, 1);
  assert.equal(m.phone, 2);
  assert.equal(m.doctor, 3);
  assert.equal(m.description, 4);
  assert.ok(!Object.values(m).includes(5));
});

test('displayed times become 24h', () => {
  assert.equal(time24_('2:00:00 PM'), '14:00:00');
  assert.equal(time24_('12:00:00 AM'), '00:00:00');
  assert.equal(time24_('9:15 م'), '21:15:00');
  assert.equal(time24_('08:05'), '08:05:00');
  assert.equal(time24_(''), '');
});

test('linked sheets: upgrades the old single-sheet settings and pushes each sheet with its own branch', () => {
  const store = { WEBHOOK_URL: 'https://x/api/webhooks/complaints', WEBHOOK_SECRET: 's', SHEET_NAME: 'Form Responses 1', DEFAULT_BRANCH: 'بريدة' };
  const props = {
    getProperty: k => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = v; },
    setProperties: o => Object.assign(store, o),
    deleteProperty: k => { delete store[k]; }
  };
  const sheet = (id, name, headers, rows) => ({
    getSheetId: () => id, getName: () => name, getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange: (r, c, nr, nc) => ({
      getDisplayValues: () => (r === 1 ? [headers] : rows.slice(r - 2, r - 2 + nr)),
      getValues: () => rows.slice(r - 2, r - 2 + nr)
    })
  });
  const headers = ['Timestamp', 'Describe the complaint\nاكتب الشكوى', 'Patient name\nاسم المريض'];
  const s1 = sheet(11, 'Form Responses 1', headers, [['t', 'تأخير الموعد', 'Ahmad']]);
  const s2 = sheet(22, 'Form Responses 2', headers, [['t', 'انتظار طويل', 'Sara'], ['t', '', 'x']]);
  const posted = [];
  const sb = {
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'SS', getSheets: () => [s1, s2], getSheetByName: n => [s1, s2].find(x => x.getName() === n), getSpreadsheetTimeZone: () => 'Asia/Riyadh' }) },
    Utilities: { formatDate: () => '' },
    UrlFetchApp: { fetch: (u, o) => { const rows = JSON.parse(o.payload).rows; posted.push(...rows); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, inserted: rows.length }) }; } }
  };
  vm.runInNewContext(src, sb);
  assert.deepEqual(JSON.parse(JSON.stringify(sb.linkedSheets_(props))), [{ id: 11, name: 'Form Responses 1', branch: 'بريدة' }]);
  store.SHEETS = JSON.stringify([{ id: 11, name: 'Form Responses 1', branch: 'بريدة' }, { id: 22, name: 'Form Responses 2', branch: 'عنيزة' }]);
  const r = sb.pushNew();
  assert.equal(r.sent, 2);
  assert.deepEqual(posted.map(p => [p.source_key, p.branch, p.description]), [
    ['SS:Form Responses 1:2', 'بريدة', 'تأخير الموعد'],
    ['SS:Form Responses 2:2', 'عنيزة', 'انتظار طويل']
  ]);
  assert.equal(JSON.stringify(posted).includes('Ahmad'), false, 'patient name never sent');
  assert.equal(store['LAST_ROW:22'], '3', 'pointer advances past the empty row too');
  assert.equal(sb.pushNew().sent, 0, 'nothing re-sent');
});

const RATING_HEADERS = [
  'Timestamp',
  'It was easy to schedule my appointment \nكان من السهل تحديد موعدي',
  'I was greeted courteously when I arrived\nاستُقبلتُ بحفاوة عند وصولي',
  'The waiting time before being seen was reasonable\nكان وقت الانتظار قبل الحصول على الرعاية معقولاً\n',
  'The provider explained my diagnosis and treatment options in a way I could understand\nشرح لي الطبيب تشخيصي وخيارات العلاج بطريقة أستطيع فهمها\n',
  'Overall, I am satisfied with the care I received\nبشكل عام، أنا راضٍ عن الرعاية التي تلقيتها',
  'I would recommend this center to family or friends.\nأوصي بهذا المركز للعائلة أو الأصدقاء',
  'OVERALL SATISFACTION\nالرضا العام',
  'Date  of visit  تاريخ الزيارة\n',
  'Time of visit  وقت الزيارة\n '
];

test('the real service-rating sheet is detected and every question maps to its own column', () => {
  assert.equal(sandbox.sheetType_(RATING_HEADERS), 'ratings');
  const m = sandbox.matchHeaders_(RATING_HEADERS, sandbox.RATING_FIELDS);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), {
    visit_date: 8, visit_time: 9, date: 0, q_booking: 1, q_reception: 2, q_waiting: 3, q_explanation: 4, q_overall: 7, q_care: 5, q_recommend: 6
  });
  assert.equal(sandbox.sheetType_(['Timestamp', 'Please state the complaint\nيرجى توضيح الشكوى', 'DATE OF EVENT\nتاريخ الحدث']), 'complaints');
});

test('rating sheets push their answers as text to /api/webhooks/ratings with the sheet branch', () => {
  const store = { WEBHOOK_URL: 'https://pe.example/api/webhooks/complaints', WEBHOOK_SECRET: 's',
    SHEETS: JSON.stringify([{ id: 5, name: 'Form Responses 1', branch: 'عنيزة', type: 'ratings' }]) };
  const props = { getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; } };
  const row = ['ts', 'Strongly agree  أوافق بشدة', 'Agree     يوافق', 'Strongly disagree    أرفض بشدة', 'Neutral     حيادي', 'Agree يوافق', 'Probably not   ربما لا', 'Poor فقير', 'd', '3:18:00 PM'];
  const sheet = {
    getSheetId: () => 5, getName: () => 'Form Responses 1', getLastRow: () => 2, getLastColumn: () => RATING_HEADERS.length,
    getRange: (r) => ({ getDisplayValues: () => (r === 1 ? [RATING_HEADERS] : [row]), getValues: () => [row] })
  };
  const calls = [];
  const sb = {
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'SS', getSheets: () => [sheet], getSpreadsheetTimeZone: () => 'Asia/Riyadh' }) },
    Utilities: { formatDate: () => '' },
    UrlFetchApp: { fetch: (u, o) => { calls.push({ u, rows: JSON.parse(o.payload).rows }); return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"inserted":1}' }; } }
  };
  vm.runInNewContext(src, sb);
  const r = sb.pushNew();
  assert.equal(r.sent, 1);
  assert.equal(calls[0].u, 'https://pe.example/api/webhooks/ratings');
  const sent = calls[0].rows[0];
  assert.equal(sent.branch, 'عنيزة');
  assert.equal(sent.q_waiting, 'Strongly disagree    أرفض بشدة');
  assert.equal(sent.q_overall, 'Poor فقير');
  assert.equal(sent.source_key, 'SS:Form Responses 1:2');
});

test('the system URL is accepted as the base or with /complaints or /ratings, and each type goes to its path', () => {
  const b = 'https://apexcare-patient-experience.onrender.com/api/webhooks';
  for (const u of [b, b + '/', b + '/complaints', b + '/ratings']) assert.equal(sandbox.webhookBase_(u), b, u);
  for (const u of ['http://x/api/webhooks', 'https://x/api/other', '']) assert.equal(sandbox.webhookBase_(u), '', u);
});

test('the real complaints sheet (QR) is detected as complaints with the right columns', () => {
  const h = ['Timestamp', 'Please state the complaint:\nيرجى توضيح الشكوى\n', 'DATE OF EVENT\nتاريخ الحدث\n', 'TIME  OF EVENT\nوقت الحدث\n',
    'Please provide your phone number to update you with any action plan made for your complaint.\nيرجى تزويدنا برقم هاتفك لنطلعك على أي خطة عمل يتم وضعها بشأن شكواك.\n'];
  assert.equal(sandbox.sheetType_(h), 'complaints');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.matchHeaders_(h))), { date: 2, time: 3, phone: 4, description: 1 });
});
