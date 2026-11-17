'use strict';

// Upload of a CRM patient export: builds the day's call list from targeted visits, and records how well
// each employee opened files. Patient names and ID numbers are read in memory only (see server/crm.js).

const express = require('express');
const { must, audit } = require('../db');
const { can, requirePerm } = require('../access');
const { UserError, normalizeFileNo, UUID_RE } = require('../validate');
const { localToUtc, localParts, addDays } = require('../time');
const { requirePhone } = require('./calls');
const C = require('../crm');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const HEADERS_KEY = 'crm_last_headers';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const loadSettings = (db) => C.loadSettings(db);
async function saveSetting(db, key, value) {
  await must(db.from('app_settings').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }));
}

function crmRoutes() {
  const r = express.Router();
  // Targeted visits kept between «رفع الملف» and «إنشاء القائمة», per upload, for 30 minutes. No names in them.
  const uploads = new Map();
  const sweep = () => { const now = Date.now(); for (const [k, v] of uploads) if (v.expires < now) uploads.delete(k); };

  const canSee = (u) => can(u, 'importCalls') || can(u, 'fileQuality') || can(u, 'manageSetup');

  r.get('/settings', async (req, res) => {
    if (!canSee(req.user)) throw new UserError('لا تملك صلاحية لهذا الإجراء', 403);
    const { db } = req.ctx;
    const [settings, doctors, headersRow] = await Promise.all([
      loadSettings(db),
      must(db.from('doctors').select('id,name,name_ar,active').order('name')),
      must(db.from('app_settings').select('value').eq('key', HEADERS_KEY).maybeSingle())
    ]);
    let lastHeaders = [];
    try { lastHeaders = headersRow ? JSON.parse(headersRow.value) : []; } catch { lastHeaders = []; }
    res.json({
      ok: true, settings, lastHeaders, doctors,
      fields: Object.entries(C.FIELDS).map(([key, f]) => ({ key, label: f.label, role: f.role, aliases: f.aliases })),
      errorLabels: C.ERRORS
    });
  });

  r.put('/settings', requirePerm('manageSetup'), async (req, res) => {
    const settings = C.mergeSettings(req.body || {});
    await saveSetting(req.ctx.db, C.SETTINGS_KEY, settings);
    await audit(req.ctx.db, req.user.username, 'update_crm_settings', JSON.stringify(settings).slice(0, 280));
    res.json({ ok: true, settings });
  });

  // Body: the .xlsx file itself. ?date=YYYY-MM-DD picks the visit day (default: yesterday, Riyadh time).
  // ?for=quality (from the file-quality tab) checks file quality only and builds no call list,
  // so it is open to whoever sees that tab; the call-list part needs importCalls.
  const uploadAllowed = (req, _res, next) => next(can(req.user, 'importCalls') || can(req.user, 'fileQuality')
    ? undefined : new UserError('لا تملك صلاحية لهذا الإجراء', 403));
  r.post('/upload', uploadAllowed, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    const { db, config } = req.ctx;
    const today = localParts(new Date(), config.tz).date;
    const date = DATE_RE.test(String(req.query.date || '')) ? String(req.query.date) : addDays(today, -1);
    let fileName = String(req.get('x-file-name') || '');
    try { fileName = decodeURIComponent(fileName); } catch { /* keep as sent */ }
    fileName = fileName.slice(0, 120);
    const book = await C.readWorkbook(req.body);
    const settings = await loadSettings(db);
    const map = C.mapColumns(book.headers, settings.columns);
    const mapping = Object.fromEntries(Object.keys(C.FIELDS).map(k => [k, map[k] === undefined ? null : book.headers[map[k]]]));
    await saveSetting(db, HEADERS_KEY, book.headers.filter(Boolean).slice(0, 200));

    // 1) Call list: visits whose latest appointment was completed on `date`.
    const forCalls = can(req.user, 'importCalls') && req.query.for !== 'quality';
    const missingForCalls = forCalls ? ['fileNo', 'phone', 'apptDate', 'apptStatus'].filter(k => map[k] === undefined) : [];
    const targets = !forCalls || missingForCalls.length ? [] : C.targetVisits(book, map, settings, date);
    const [doctors, users] = await Promise.all([
      must(db.from('doctors').select('id,name,name_ar,active')),
      must(db.from('app_users').select('id,name,role,branch,active'))
    ]);
    const callers = !forCalls ? [] : users.filter(u => u.active && can(u, 'calls') && u.role !== 'admin').map(u => ({ id: u.id, name: u.name, branch: u.branch || '' }));
    const counts = new Map();
    targets.forEach(t => counts.set(t.doctor, (counts.get(t.doctor) || 0) + 1));
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([crm, count]) => {
      const saved = settings.doctorMap[crm];
      const doctorId = saved !== undefined ? saved : C.suggestDoctor(crm, doctors.filter(d => d.active));
      return { crm, count, doctorId: doctorId || null, remembered: saved !== undefined,
        picked: settings.lastPicks.length ? settings.lastPicks.includes(crm) : !!doctorId };
    });
    sweep();
    const token = require('node:crypto').randomUUID();
    uploads.set(token, { userId: req.user.id, date, targets, expires: Date.now() + TOKEN_TTL_MS });

    // 2) File-opening quality, saved without names or ID numbers.
    let quality = null;
    const canCheck = ['nameAr', 'nameEn', 'idNumber', 'birthDateOk', 'createdBy'].some(k => map[k] !== undefined);
    if (canCheck) {
      const q = C.analyzeQuality(book, map, settings.rules);
      const run = await must(db.from('crm_quality_runs').insert({
        uploaded_by: req.user.username, file_name: fileName || null, total: q.total, complete: q.complete,
        period_from: q.periodFrom, period_to: q.periodTo, staff: q.staff, errors: q.errors
      }).select('id').single());
      quality = { runId: run.id, total: q.total, complete: q.complete, staff: q.staff.length };
    }
    await audit(db, req.user.username, 'crm_upload', `rows=${book.rows.length} date=${date} targets=${targets.length} quality=${quality ? quality.runId : '-'}`);
    res.json({
      ok: true, token, date, rows: book.rows.length, mapping, missingForCalls,
      targets: targets.length, groups, listSize: settings.listSize, quality,
      callers, lastAssignees: settings.lastAssignees.filter(id => callers.some(c => c.id === id))
    });
  });

  // Body: { token, picks: [{ crm, doctorId }], count }. Takes `count` visits at random from the picked doctors/clinics.
  r.post('/build-list', requirePerm('importCalls'), async (req, res) => {
    const { db, config } = req.ctx;
    sweep();
    const up = uploads.get(String(req.body?.token || ''));
    if (!up || up.userId !== req.user.id) throw new UserError('انتهت صلاحية الملف المرفوع. ارفعه مرة أخرى', 410);
    const picks = Array.isArray(req.body?.picks) ? req.body.picks.filter(p => p && typeof p.crm === 'string').slice(0, 200) : [];
    if (!picks.length) throw new UserError('اختر طبيباً أو عيادة واحدة على الأقل');
    const count = Number.isInteger(+req.body?.count) && +req.body.count > 0 ? Math.min(+req.body.count, 1000) : 40;
    const [doctors, users] = await Promise.all([must(db.from('doctors').select('id,branch')), must(db.from('app_users').select('id,role,active'))]);
    const known = new Map(doctors.map(d => [d.id, d]));
    // The list is split evenly between the chosen employees (in turn), or left for anyone when none is chosen.
    const assignees = (Array.isArray(req.body?.assignees) ? req.body.assignees : []).filter(id => typeof id === 'string' && UUID_RE.test(id));
    const callerIds = new Set(users.filter(u => u.active && can(u, 'calls')).map(u => u.id));
    const unknown = assignees.filter(id => !callerIds.has(id));
    if (unknown.length) throw new UserError('اختر موظفات لهن صلاحية قائمة الاتصال');
    const chosen = new Map();
    for (const p of picks) {
      const id = typeof p.doctorId === 'string' && UUID_RE.test(p.doctorId) && known.has(p.doctorId) ? p.doctorId : null;
      chosen.set(p.crm, id);
    }

    // Remember the CRM → system doctor links for next time.
    const settings = await loadSettings(db);
    let mapChanged = false;
    for (const [crm, id] of chosen) if (settings.doctorMap[crm] !== id) { settings.doctorMap[crm] = id; mapChanged = true; }
    settings.lastPicks = [...chosen.keys()];
    settings.lastAssignees = [...new Set(assignees)];
    settings.listSize = count;
    await saveSetting(db, C.SETTINGS_KEY, C.mergeSettings(settings));
    void mapChanged;

    const pool = up.targets.filter(t => chosen.has(t.doctor));
    const picked = C.sample(pool, count);
    const good = new Map();
    const errors = [];
    const uniqueAssignees = [...new Set(assignees)];
    let turn = 0;
    for (const t of picked) {
      try {
        const doctorId = chosen.get(t.doctor);
        const d = doctorId ? known.get(doctorId) : null;
        const item = {
          file_no: normalizeFileNo(t.fileNo),
          phone: requirePhone(t.phone),
          doctor_id: doctorId,
          doctor_name_raw: doctorId ? null : (t.doctor || null),
          branch: t.branch || (d && d.branch !== 'الكل' ? d.branch : null),
          visit_at: localToUtc(t.visitDate, t.visitTime, config.tz).toISOString(),
          updated_by: req.user.username,
          assigned_to: uniqueAssignees.length ? uniqueAssignees[turn++ % uniqueAssignees.length] : null
        };
        good.set(`${item.file_no}|${item.visit_at}`, item);
      } catch (e) {
        if (!e.userMessage) throw e;
        errors.push({ fileNo: t.fileNo, error: e.message });
      }
    }
    let inserted = 0;
    if (good.size) {
      const out = await must(db.from('call_queue').upsert([...good.values()], { onConflict: 'file_no,visit_at', ignoreDuplicates: true }).select('id'));
      inserted = out.length;
    }
    await audit(db, req.user.username, 'crm_build_list', `date=${up.date} pool=${pool.length} picked=${picked.length} inserted=${inserted} errors=${errors.length}`);
    const perAssignee = {};
    for (const it of good.values()) if (it.assigned_to) perAssignee[it.assigned_to] = (perAssignee[it.assigned_to] || 0) + 1;
    res.json({ ok: true, date: up.date, pool: pool.length, picked: picked.length, inserted, duplicates: good.size - inserted, perAssignee, errors: errors.slice(0, 50), errorCount: errors.length });
  });

  // Several files for one period → one report. Each file is sent on its own to /quality/part (kept in
  // memory under a token for 30 minutes, names and IDs included, never stored), then /quality/finish
  // merges them, checks them and saves one report without names or IDs.
  const parts = new Map();
  const sweepParts = () => { const now = Date.now(); for (const [k, v] of parts) if (v.expires < now) parts.delete(k); };
  const QUALITY_KEYS = ['nameAr', 'nameEn', 'idNumber', 'birthDateOk', 'createdBy'];
  const MAX_FILES = 12;

  r.post('/quality/part', uploadAllowed, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    sweepParts();
    let fileName = String(req.get('x-file-name') || '');
    try { fileName = decodeURIComponent(fileName); } catch { /* keep as sent */ }
    fileName = fileName.slice(0, 120);
    const book = await C.readWorkbook(req.body);
    const settings = await loadSettings(req.ctx.db);
    const map = C.mapColumns(book.headers, settings.columns);
    if (!QUALITY_KEYS.some(k => map[k] !== undefined)) {
      throw new UserError(`لم أجد في «${fileName || 'الملف'}» أعمدة الاسم أو الهوية أو تاريخ الميلاد أو من فتح الملف. حدّد أسماءها من الإدارة ← إعدادات ملف CRM.`);
    }
    await saveSetting(req.ctx.db, HEADERS_KEY, book.headers.filter(Boolean).slice(0, 200));
    let token = String(req.query.token || '');
    let batch = parts.get(token);
    if (!batch || batch.userId !== req.user.id) {
      token = require('node:crypto').randomUUID();
      batch = { userId: req.user.id, files: [], expires: 0 };
      parts.set(token, batch);
    }
    if (batch.files.length >= MAX_FILES) throw new UserError(`الحد ${MAX_FILES} ملفاً في التقرير الواحد`);
    const rows = batch.files.reduce((a, f) => a + f.book.rows.length, 0) + book.rows.length;
    if (rows > 200000) throw new UserError('مجموع الصفوف كبير جداً لتقرير واحد');
    batch.files.push({ name: fileName, book, map });
    batch.expires = Date.now() + TOKEN_TTL_MS;
    res.json({ ok: true, token, files: batch.files.length, rows: book.rows.length });
  });

  r.post('/quality/finish', uploadAllowed, async (req, res) => {
    sweepParts();
    const token = String(req.body?.token || '');
    const batch = parts.get(token);
    if (!batch || batch.userId !== req.user.id || !batch.files.length) throw new UserError('انتهت مهلة الرفع، ارفع الملفات من جديد');
    parts.delete(token);
    const { db } = req.ctx;
    const settings = await loadSettings(db);
    const { book, map } = C.mergeBooks(batch.files);
    const q = C.analyzeQuality(book, map, settings.rules);
    const names = batch.files.map(f => f.name).filter(Boolean);
    const fileName = (names.length > 1 ? `${names.length} ملفات: ${names.join('، ')}` : names[0] || '').slice(0, 120) || null;
    const run = await must(db.from('crm_quality_runs').insert({
      uploaded_by: req.user.username, file_name: fileName, total: q.total, complete: q.complete,
      period_from: q.periodFrom, period_to: q.periodTo, staff: q.staff, errors: q.errors
    }).select('id').single());
    const sent = batch.files.reduce((a, f) => a + f.book.rows.length, 0);
    await audit(db, req.user.username, 'crm_quality', `files=${batch.files.length} rows=${sent} unique=${q.total} run=${run.id}`);
    res.json({ ok: true, quality: { runId: run.id, total: q.total, complete: q.complete, staff: q.staff.length, files: batch.files.length, duplicates: sent - q.total } });
  });

  r.get('/quality/runs', requirePerm('fileQuality'), async (req, res) => {
    const rows = await must(req.ctx.db.from('crm_quality_runs')
      .select('id,created_at,uploaded_by,file_name,total,complete,period_from,period_to')
      .order('created_at', { ascending: false }).limit(50));
    res.json({ ok: true, rows });
  });

  r.get('/quality/runs/:id', requirePerm('fileQuality'), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new UserError('التقرير غير موجود', 404);
    const run = await must(req.ctx.db.from('crm_quality_runs').select('*').eq('id', req.params.id).maybeSingle());
    if (!run) throw new UserError('التقرير غير موجود', 404);
    res.json({ ok: true, run, errorLabels: C.ERRORS });
  });

  return r;
}

module.exports = crmRoutes;
