'use strict';

// Runs the complaints-sheet Apps Script's pure helpers in a sandbox (no Google services).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'complaints-sheet', 'Code.gs'), 'utf8');
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
