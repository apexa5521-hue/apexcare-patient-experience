'use strict';

// Reading a patient export from the clinic's CRM (an .xlsx file). Each client's CRM may name its columns
// differently, so every field is found by header name: first an exact match, then a partial one, and the
// admin can pin a field to a specific header in the settings.
//
// Privacy: the file holds patient names and ID numbers. They are read in memory to check how well each
// file was opened, and are never stored or sent back: only file numbers, staff names, dates and error codes leave.

const ExcelJS = require('exceljs');
const { UserError, normalizeBranch } = require('./validate');
const { must } = require('./db');

const MAX_ROWS = 50000;

/** Fields we read. `aliases`: header names tried in order. `role`: what the field is used for. */
const FIELDS = {
  fileNo:        { label: 'رقم الملف', role: 'both', aliases: ['رقم الملف', 'الرقم الملف للمريض', 'رقم الملف الطبي', 'File Number', 'File No'] },
  phone:         { label: 'رقم الجوال', role: 'calls', aliases: ['رقم الهاتف', 'رقم الجوال', 'الجوال', 'الهاتف', 'Phone', 'Mobile'] },
  doctor:        { label: 'الطبيب / العيادة', role: 'calls', aliases: ['طبيب', 'الطبيب', 'Doctor'] },
  branch:        { label: 'الفرع', role: 'calls', aliases: ['الفرع', 'Branch'] },
  apptDate:      { label: 'تاريخ آخر موعد', role: 'calls', aliases: ['آخر موعد Date', 'اخر موعد Date', 'Last Appointment Date'] },
  apptStatus:    { label: 'حالة آخر موعد', role: 'calls', aliases: ['آخر موعد Status', 'اخر موعد Status', 'Last Appointment Status'] },
  createdBy:     { label: 'فتح الملف بواسطة', role: 'quality', aliases: ['تم الإنشاء بواسطة', 'تم انشاءه بواسطة', 'أنشأ بواسطة', 'انشأ بواسطة', 'منشئ الملف', 'Created By'] },
  createdAt:     { label: 'تاريخ فتح الملف', role: 'quality', aliases: ['تم الإنشاء', 'تاريخ الإنشاء', 'تاريخ إنشاء الملف', 'Created Date', 'Create Date'] },
  nameAr:        { label: 'اسم المريض (عربي)', role: 'quality', aliases: ['الإسم الأول', 'الاسم الأول', 'الاسم بالعربي', 'الاسم العربي', 'الاسم الكامل'] },
  nameEn:        { label: 'اسم المريض (إنجليزي)', role: 'quality', aliases: ['إسم العائلة', 'اسم العائلة', 'الاسم بالإنجليزي', 'الاسم الإنجليزي', 'Full Name', 'Last Name'] },
  idNumber:      { label: 'رقم الهوية', role: 'quality', aliases: ['رقم الهوية الوطنية', 'رقم الهوية', 'الهوية', 'ID Number'] },
  birthDateOk:   { label: 'تاريخ الميلاد صحيح', role: 'quality', aliases: ['تاريخ الميلاد صحيح', 'تاريخ الولادة صحيح'] }
};

/** Defaults for a new client; everything here can be changed from the admin settings. */
const DEFAULT_SETTINGS = {
  columns: {},                         // field -> exact header text, when the admin pins one
  completedStatuses: ['مكتمل'],        // appointment statuses that count as a finished visit
  dailyMinPerStaff: 20,                // call-survey experiences each employee should record per day
  listSize: 40,                        // how many targeted visits go into the day's call list
  rules: { nameArQuad: true, nameEnQuad: true, idNumber: true, birthDateOk: true },
  doctorMap: {},                       // CRM doctor/clinic text -> system doctor id
  lastPicks: [],                       // CRM doctors/clinics chosen last time (ticked again on the next upload)
  lastAssignees: []                    // employees the last list was split between
};
const SETTINGS_KEY = 'crm_settings';

/** Messages for the quality error codes. Name errors never show the name itself. */
const ERRORS = {
  file_empty: 'رقم الملف فارغ',
  creator_empty: 'لم يُسجَّل من فتح الملف',
  name_ar_empty: 'اسم المريض بالعربي فارغ، يرجى مراجعة نظام CRM',
  name_ar_short: 'خطأ في اسم المريض بالعربي (غير رباعي)، يرجى مراجعة نظام CRM',
  name_en_empty: 'اسم المريض بالإنجليزي فارغ، يرجى مراجعة نظام CRM',
  name_en_short: 'خطأ في اسم المريض بالإنجليزي (غير رباعي)، يرجى مراجعة نظام CRM',
  id_empty: 'رقم الهوية فارغ',
  id_invalid: 'رقم الهوية غير صحيح',
  birth_unchecked: 'تاريخ الميلاد غير مؤكد'
};

const norm = s => String(s ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
const arDigits = s => String(s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

/** Merges saved settings over the defaults, keeping only known keys and sane values. */
function mergeSettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const int = (v, d, lo, hi) => (Number.isInteger(+v) && +v >= lo && +v <= hi ? +v : d);
  const columns = {};
  for (const k of Object.keys(FIELDS)) if (s.columns && typeof s.columns[k] === 'string' && norm(s.columns[k])) columns[k] = norm(s.columns[k]).slice(0, 120);
  const statuses = Array.isArray(s.completedStatuses) ? s.completedStatuses.map(norm).filter(Boolean).slice(0, 10) : [];
  const rules = { ...DEFAULT_SETTINGS.rules };
  for (const k of Object.keys(rules)) if (s.rules && typeof s.rules[k] === 'boolean') rules[k] = s.rules[k];
  const doctorMap = {};
  if (s.doctorMap && typeof s.doctorMap === 'object') {
    for (const [k, v] of Object.entries(s.doctorMap).slice(0, 500)) if (norm(k) && (v === null || typeof v === 'string')) doctorMap[norm(k).slice(0, 120)] = v;
  }
  const strings = (v, n) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(norm).filter(Boolean))].slice(0, n) : []);
  return {
    columns,
    lastPicks: strings(s.lastPicks, 200),
    lastAssignees: strings(s.lastAssignees, 50),
    completedStatuses: statuses.length ? statuses : DEFAULT_SETTINGS.completedStatuses,
    dailyMinPerStaff: int(s.dailyMinPerStaff, DEFAULT_SETTINGS.dailyMinPerStaff, 1, 500),
    listSize: int(s.listSize, DEFAULT_SETTINGS.listSize, 1, 1000),
    rules,
    doctorMap
  };
}

/** The client's saved settings over the defaults. */
async function loadSettings(db) {
  const row = await must(db.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle());
  let saved = null;
  try { saved = row && row.value ? JSON.parse(row.value) : null; } catch { saved = null; }
  return mergeSettings(saved);
}

/** Finds each field's column: the admin's pinned header, else an exact alias, else a partial one. A header is used once. */
function mapColumns(headers, pinned = {}) {
  const H = headers.map(norm);
  const used = new Set();
  const map = {};
  const take = (k, i) => { map[k] = i; used.add(i); };
  for (const k of Object.keys(FIELDS)) {
    if (!pinned[k]) continue;
    const i = H.findIndex((h, j) => !used.has(j) && h === norm(pinned[k]));
    if (i >= 0) take(k, i);
  }
  for (const [k, f] of Object.entries(FIELDS)) {
    if (map[k] !== undefined) continue;
    for (const a of f.aliases) { const i = H.findIndex((h, j) => !used.has(j) && h === norm(a)); if (i >= 0) { take(k, i); break; } }
  }
  for (const [k, f] of Object.entries(FIELDS)) {
    if (map[k] !== undefined) continue;
    for (const a of f.aliases) {
      const an = norm(a);
      const i = H.findIndex((h, j) => !used.has(j) && h && (h.includes(an) || an.includes(h)));
      if (i >= 0) { take(k, i); break; }
    }
  }
  return map;
}

const pad = n => String(n).padStart(2, '0');
/** A cell as plain text. Dates (stored without a time zone in Excel) come back as local "YYYY-MM-DD HH:MM". */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    return '';
  }
  return String(v);
}

/** "YYYY-MM-DD HH:MM" (or with seconds, or "/" separators) -> { date, time }, else null. */
function splitDateTime(s) {
  const m = arDigits(norm(s)).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : '00:00' };
}

/** Reads the first sheet of an .xlsx file into header texts and rows of texts. */
async function readWorkbook(buffer) {
  if (!buffer || !buffer.length) throw new UserError('الملف فارغ');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new UserError('تعذّرت قراءة الملف. ارفع ملف Excel بصيغة ‎.xlsx'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new UserError('الملف لا يحتوي على أي ورقة');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, row => {
    if (rows.length > MAX_ROWS + 1) return;
    const vals = row.values; // 1-based
    const out = [];
    for (let c = 1; c < vals.length; c++) out.push(cellText(vals[c]));
    rows.push(out);
  });
  if (rows.length > MAX_ROWS + 1) throw new UserError(`الملف كبير جداً: الحد ${MAX_ROWS} صف`);
  if (rows.length < 2) throw new UserError('لا توجد صفوف بعد صف العناوين');
  const headers = rows[0].map(norm);
  return { headers, rows: rows.slice(1).filter(r => r.some(v => norm(v))) };
}

/** National ID: starts with 1 and has exactly 10 digits; iqama and others: 9 to 14 digits. (Rule from the v4 file checker.) */
function validId(v) {
  const id = arDigits(String(v)).replace(/\s/g, '');
  if (!/^\d+$/.test(id)) return false;
  return id[0] === '1' ? id.length === 10 : id.length >= 9 && id.length <= 14;
}
const quad = v => norm(v).split(' ').filter(Boolean).length >= 4;
const isTrue = v => { const t = norm(v).toLowerCase(); return t === 'صحيح' || t === 'true' || t === 'نعم' || t === 'yes'; };

/** Error codes for one row, by the client's rules. Only columns found in the file are checked. */
function rowErrors(row, map, rules) {
  const get = k => (map[k] === undefined ? undefined : norm(row[map[k]]));
  const errs = [];
  if (get('fileNo') === '') errs.push('file_empty');
  if (get('createdBy') === '') errs.push('creator_empty');
  const ar = get('nameAr'), en = get('nameEn'), id = get('idNumber'), b = get('birthDateOk');
  if (rules.nameArQuad && ar !== undefined) { if (!ar) errs.push('name_ar_empty'); else if (!quad(ar)) errs.push('name_ar_short'); }
  if (rules.nameEnQuad && en !== undefined) { if (!en) errs.push('name_en_empty'); else if (!quad(en)) errs.push('name_en_short'); }
  if (rules.idNumber && id !== undefined) { if (!id) errs.push('id_empty'); else if (!validId(id)) errs.push('id_invalid'); }
  if (rules.birthDateOk && b !== undefined && !isTrue(b)) errs.push('birth_unchecked');
  return errs;
}

/** File-opening quality for the whole upload: per employee, and the rows with errors (file number, employee, date, codes only). */
function analyzeQuality({ rows }, map, rules) {
  const byCreator = new Map();
  const errors = [];
  let from = null, to = null;
  for (const row of rows) {
    const creator = (map.createdBy !== undefined && norm(row[map.createdBy])) || 'غير محدد';
    const created = map.createdAt !== undefined ? splitDateTime(row[map.createdAt]) : null;
    const when = created ? `${created.date} ${created.time}` : '';
    if (when) { if (!from || when < from) from = when; if (!to || when > to) to = when; }
    const codes = rowErrors(row, map, rules);
    const c = byCreator.get(creator) || { creator, total: 0, complete: 0, incomplete: 0, codes: {} };
    c.total++;
    if (codes.length) {
      c.incomplete++;
      codes.forEach(k => { c.codes[k] = (c.codes[k] || 0) + 1; });
      errors.push({ fileNo: map.fileNo !== undefined ? norm(row[map.fileNo]).slice(0, 30) : '', creator, createdAt: when, codes });
    } else c.complete++;
    byCreator.set(creator, c);
  }
  const staff = [...byCreator.values()].map(c => ({ ...c, rate: c.total ? Math.round((c.complete / c.total) * 1000) / 10 : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);
  const complete = staff.reduce((a, c) => a + c.complete, 0);
  return { total: rows.length, complete, incomplete: rows.length - complete, periodFrom: from, periodTo: to, staff, errors };
}

/**
 * Several exports covering one period, as one sheet: each file's rows are put in a common column order
 * (the FIELDS keys), and a file number seen in more than one file is counted once (the later file wins).
 * parts: [{ book, map }] from readWorkbook + mapColumns. Returns { book, map } for analyzeQuality.
 */
function mergeBooks(parts) {
  const keys = Object.keys(FIELDS);
  const present = keys.filter(k => parts.some(p => p.map[k] !== undefined));
  const map = Object.fromEntries(present.map((k, i) => [k, i]));
  const byFile = new Map(), noFile = [];
  for (const { book, map: m } of parts) {
    for (const row of book.rows) {
      const out = present.map(k => (m[k] === undefined ? '' : row[m[k]]));
      const no = map.fileNo !== undefined ? norm(out[map.fileNo]) : '';
      if (no) { byFile.delete(no); byFile.set(no, out); } else noFile.push(out);
    }
  }
  return { book: { headers: present, rows: [...byFile.values(), ...noFile] }, map };
}

/** Visits whose latest appointment has a completed status on `date` (YYYY-MM-DD, local). Names are not read. */
function targetVisits({ rows }, map, settings, date) {
  const done = new Set(settings.completedStatuses.map(norm));
  const out = [];
  for (const row of rows) {
    const status = map.apptStatus !== undefined ? norm(row[map.apptStatus]) : '';
    if (!done.has(status)) continue;
    const when = map.apptDate !== undefined ? splitDateTime(row[map.apptDate]) : null;
    if (!when || when.date !== date) continue;
    out.push({
      fileNo: map.fileNo !== undefined ? norm(row[map.fileNo]) : '',
      phone: map.phone !== undefined ? norm(row[map.phone]) : '',
      doctor: map.doctor !== undefined ? norm(row[map.doctor]) : '',
      branch: map.branch !== undefined ? normalizeBranch(row[map.branch]) : null,
      visitDate: when.date,
      visitTime: when.time
    });
  }
  return out;
}

/** Name key for matching a CRM doctor/clinic text to a system one: no title, no «ال», one alef/ta/ya form. */
function nameKey(s) {
  return norm(s).toLowerCase()
    .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/^(الدكتوره|الدكتور|دكتوره|دكتور|د\s*[./]\s*|د\s+|dr\.?\s*)/i, '')
    .replace(/[-_.،,|]/g, ' ').split(/\s+/).filter(Boolean).map(t => t.replace(/^ال(?=..)/, '')).join(' ');
}

/** Suggests the system doctor for a CRM name: same name (Arabic or English), else a unique first-name match. */
function suggestDoctor(crmName, doctors) {
  const k = nameKey(crmName);
  if (!k) return null;
  const keys = doctors.map(d => ({ d, ks: [nameKey(d.name), nameKey(d.name_ar || '')].filter(Boolean) }));
  const exact = keys.filter(x => x.ks.includes(k));
  if (exact.length === 1) return exact[0].d.id;
  const first = k.split(' ')[0];
  const byFirst = keys.filter(x => x.ks.some(n => n.split(' ')[0] === first));
  return byFirst.length === 1 ? byFirst[0].d.id : null;
}

/** Picks `n` items at random (Fisher–Yates on a copy). */
function sample(list, n, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

module.exports = {
  mergeBooks,
  FIELDS, DEFAULT_SETTINGS, SETTINGS_KEY, ERRORS, MAX_ROWS,
  mergeSettings, loadSettings, mapColumns, readWorkbook, cellText, splitDateTime,
  validId, rowErrors, analyzeQuality, targetVisits, nameKey, suggestDoctor, sample
};
