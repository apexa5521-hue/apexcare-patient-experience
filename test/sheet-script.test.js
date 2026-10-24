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
