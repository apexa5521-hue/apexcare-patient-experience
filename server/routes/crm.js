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
  r.post('/upload', requirePerm('importCalls'), express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
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
    const missingForCalls = ['fileNo', 'phone', 'apptDate', 'apptStatus'].filter(k => map[k] === undefined);
    const targets = missingForCalls.length ? [] : C.targetVisits(book, map, settings, date);
    const doctors = await must(db.from('doctors').select('id,name,name_ar,active'));
    const counts = new Map();
    targets.forEach(t => counts.set(t.doctor, (counts.get(t.doctor) || 0) + 1));
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([crm, count]) => {
      const saved = settings.doctorMap[crm];
      const doctorId = saved !== undefined ? saved : C.suggestDoctor(crm, doctors.filter(d => d.active));
      return { crm, count, doctorId: doctorId || null, remembered: saved !== undefined };
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
      targets: targets.length, groups, listSize: settings.listSize, quality
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
    const doctors = await must(db.from('doctors').select('id,branch'));
    const known = new Map(doctors.map(d => [d.id, d]));
    const chosen = new Map();
    for (const p of picks) {
      const id = typeof p.doctorId === 'string' && UUID_RE.test(p.doctorId) && known.has(p.doctorId) ? p.doctorId : null;
      chosen.set(p.crm, id);
    }

    // Remember the CRM → system doctor links for next time.
    const settings = await loadSettings(db);
    let mapChanged = false;
    for (const [crm, id] of chosen) if (settings.doctorMap[crm] !== id) { settings.doctorMap[crm] = id; mapChanged = true; }
    if (mapChanged) await saveSetting(db, C.SETTINGS_KEY, settings);

    const pool = up.targets.filter(t => chosen.has(t.doctor));
    const picked = C.sample(pool, count);
    const good = new Map();
    const errors = [];
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
          updated_by: req.user.username
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
    res.json({ ok: true, date: up.date, pool: pool.length, picked: picked.length, inserted, duplicates: good.size - inserted, errors: errors.slice(0, 50), errorCount: errors.length });
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
