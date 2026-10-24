'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../server/validate');
const { localToUtc, formatLocal } = require('../server/time');

const DOC = '6f1c2a8e-1b2c-4d3e-8f90-123456789abc';
const valid = (over = {}) => ({
  fileNo: 'A-1', branch: 'بريدة', doctorId: DOC, visitDate: '2026-03-10', visitTime: '10:30', visitType: 'إجراء',
  bookingRating: 5, receptionRating: 4, planExplained: 'نعم', doctorRating: 3, sentiment: 'إيجابية', ...over
});
const rejects = (data, re) => assert.throws(() => V.parse(V.experienceSchema, data), e => e.userMessage && re.test(e.message));

test('phone numbers normalize to 05XXXXXXXX', () => {
  for (const input of ['0551234567', '+966551234567', '00966551234567', '551234567', '055 123 4567', '٠٥٥١٢٣٤٥٦٧', '966551234567']) {
    assert.equal(V.normalizePhone(input), '0551234567', input);
  }
  assert.equal(V.normalizePhone(''), null);
  assert.equal(V.normalizePhone(undefined), null);
  for (const bad of ['0451234567', '05512345', '05512345678', 'abc', '+1 555 123 4567']) {
    assert.throws(() => V.normalizePhone(bad), /الجوال/, bad);
  }
  assert.equal(V.tryPhone('nonsense'), null);
});

test('file numbers: letters, digits, / and - up to 20', () => {
  assert.equal(V.normalizeFileNo(' AB-12/3 '), 'AB-12/3');
  assert.equal(V.normalizeFileNo('١٢٣'), '123');
  for (const bad of ['', 'رقم', 'A 1', 'A_1', 'x'.repeat(21), '<script>']) {
    assert.throws(() => V.normalizeFileNo(bad), /رقم الملف/, bad);
  }
});

test('phones are masked as 05*****123', () => {
  assert.equal(V.maskPhone('0551234567'), '05*****567');
  assert.equal(V.maskPhone(null), '');
});

test('negative experience requires category and severity', () => {
  rejects(valid({ sentiment: 'سلبية' }), /تصنيف/);
  rejects(valid({ sentiment: 'سلبية', category: 'وقت الانتظار' }), /الخطورة/);
  const ok = V.parse(V.experienceSchema, valid({ sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'عالية' }));
  assert.equal(ok.severity, 'عالية');
});

test('the four survey questions are required', () => {
  for (const k of ['bookingRating', 'receptionRating', 'planExplained', 'doctorRating']) {
    const d = valid(); delete d[k];
    assert.throws(() => V.parse(V.experienceSchema, d), e => e.userMessage, k);
  }
  rejects(valid({ bookingRating: 0 }), /الحجز/);
  rejects(valid({ doctorRating: 6 }), /الطبيب/);
  rejects(valid({ receptionRating: 2.5 }), /الاستقبال/);
  rejects(valid({ planExplained: 'ربما' }), /الخطة/);
});

test('"لا ينطبق" only for consultation (كشف) visits', () => {
  rejects(valid({ planExplained: 'لا ينطبق', visitType: 'إجراء' }), /لا ينطبق/);
  rejects(valid({ planExplained: 'لا ينطبق', visitType: 'كشف وإجراء' }), /لا ينطبق/);
  assert.equal(V.parse(V.experienceSchema, valid({ planExplained: 'لا ينطبق', visitType: 'كشف' })).planExplained, 'لا ينطبق');
});

test('general note is optional and capped at 1000 chars', () => {
  assert.equal(V.parse(V.experienceSchema, valid()).generalNote, null);
  assert.equal(V.parse(V.experienceSchema, valid({ generalNote: '  ممتاز  ' })).generalNote, 'ممتاز');
  assert.throws(() => V.parse(V.experienceSchema, valid({ generalNote: 'x'.repeat(1001) })));
});

test('filters validate dates, times and enums', () => {
  assert.deepEqual(V.parseFilters({ from: '2026-01-01', timeFrom: '08:00', branch: 'عنيزة', fileNo: 'A%_1', status: '' }),
    { from: '2026-01-01', timeFrom: '08:00', branch: 'عنيزة', fileNo: 'A1' });
  assert.throws(() => V.parseFilters({ from: '01/01/2026' }));
  assert.throws(() => V.parseFilters({ timeTo: '25:00' }));
  assert.throws(() => V.parseFilters({ branch: 'الرياض' }));
  assert.throws(() => V.parseFilters({ doctorId: 'x' }));
});

test('Riyadh local time converts to UTC and back', () => {
  assert.equal(localToUtc('2026-03-10', '23:30', 'Asia/Riyadh').toISOString(), '2026-03-10T20:30:00.000Z');
  assert.equal(localToUtc('2026-03-10', '01:15', 'Asia/Riyadh').toISOString(), '2026-03-09T22:15:00.000Z');
  assert.equal(formatLocal('2026-03-10T20:30:00.000Z', 'Asia/Riyadh'), '2026-03-10 23:30');
});

test('Supabase URL is accepted with or without /rest/v1', () => {
  const { normalizeSupabaseUrl } = require('../server/db');
  for (const u of ['https://abc.supabase.co', 'https://abc.supabase.co/', ' https://abc.supabase.co/rest/v1 ', 'https://abc.supabase.co/rest/v1/']) {
    assert.equal(normalizeSupabaseUrl(u), 'https://abc.supabase.co', u);
  }
});
