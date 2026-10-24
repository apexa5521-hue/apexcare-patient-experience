'use strict';

// Call list for phone surveys: visits waiting for a call, imported from the clinic system or added by hand.
// The survey itself is saved through POST /api/experiences with callId, which closes the call.

const express = require('express');
const { must, countOf, audit } = require('../db');
const { requirePerm, branchScope } = require('../access');
const { localToUtc, addDays, formatLocal } = require('../time');
const { doctorKey } = require('./complaints');
const {
  UserError, UUID_RE, BRANCHES, CALL_STATUSES, CALL_OUTCOMES, normalizeFileNo, normalizePhone, normalizeBranch, parse
} = require('../validate');
const { z } = require('zod');

const LIST_LIMIT = 500;
const IMPORT_MAX = 1000;
const OPEN = ['بانتظار الاتصال', 'لم يرد'];

const pad = (n) => String(n).padStart(2, '0');

/** Date as typed or pasted from Excel: 2026-10-24, 24/10/2026, 2026/10/24 (optionally with a time). */
function parseDate(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) return valid(+m[3], +m[2], +m[1]);
  return null;
  function valid(y, mo, d) {
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
}

/** Time as 14:30, 14:30:00, 2:30 PM or 2:30 م. */
function parseTime(v) {
  const s = String(v ?? '').trim().toLowerCase();
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (m[3] === 'pm' || m[3] === 'م') { if (h < 12) h += 12; } else if ((m[3] === 'am' || m[3] === 'ص') && h === 12) h = 0;
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

function visitInstant(dateText, timeText, tz) {
  if (!dateText && !timeText) return null;
  const date = parseDate(dateText);
  if (!date) throw new UserError('تاريخ الزيارة غير صالح');
  const time = parseTime(timeText) || parseTime(dateText) || '00:00';
  return localToUtc(date, time, tz).toISOString();
}

const callSchema = z.object({
  fileNo: z.string({ error: 'رقم الملف مطلوب' }),
  phone: z.string({ error: 'رقم الجوال مطلوب للاتصال' }),
  doctorId: z.preprocess(v => v || null, z.string().regex(UUID_RE, 'اختر الطبيب من القائمة').nullable()),
  branch: z.preprocess(v => v || null, z.string().nullable()),
  visitDate: z.preprocess(v => v || null, z.string().nullable()),
  visitTime: z.preprocess(v => v || null, z.string().nullable())
});

function mapCall(c, { tz, doctorNames }) {
  return {
    id: c.id,
    visitAt: formatLocal(c.visit_at, tz),
    fileNo: c.file_no,
    // Callers need the full number; this list is for dialling.
    phone: c.phone,
    doctorId: c.doctor_id,
    doctor: (c.doctor_id && doctorNames.get(c.doctor_id)) || c.doctor_name_raw || '',
    branch: c.branch || '',
    status: c.status,
    attempts: c.attempts,
    lastAttemptAt: formatLocal(c.last_attempt_at, tz),
    experienceId: c.experience_id
  };
}

function callRoutes() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const q = req.query;
    const status = typeof q.status === 'string' && q.status ? q.status : null;
    if (status && status !== 'open' && !CALL_STATUSES.includes(status)) throw new UserError('قيمة فلتر غير صالحة');
    const branch = branchScope(req.user) || (q.branch ? normalizeBranch(q.branch) : null);
    let query = db.from('call_queue').select('*', { count: 'exact' });
    query = !status || status === 'open' ? query.in('status', OPEN) : query.eq('status', status);
    if (branch) query = query.eq('branch', branch);
    const from = q.from ? parseDate(q.from) : null;
    const to = q.to ? parseDate(q.to) : null;
    if (from) query = query.gte('visit_at', localToUtc(from, '00:00', config.tz).toISOString());
    if (to) query = query.lt('visit_at', localToUtc(addDays(to, 1), '00:00', config.tz).toISOString());
    if (q.fileNo) query = query.ilike('file_no', `%${String(q.fileNo).replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20)}%`);

    const head = () => db.from('call_queue').select('id', { count: 'exact', head: true });
    const [{ data, count }, pending, noAnswer, done, doctors] = await Promise.all([
      must(query.order('visit_at', { ascending: false }).order('created_at', { ascending: false }).range(0, LIST_LIMIT - 1)),
      countOf(head().eq('status', 'بانتظار الاتصال')),
      countOf(head().eq('status', 'لم يرد')),
      countOf(head().eq('status', 'تم')),
      must(db.from('doctors').select('id,name'))
    ]);
    const doctorNames = new Map(doctors.map(d => [d.id, d.name]));
    res.json({
      ok: true,
      summary: { pending, noAnswer, done },
      total: count ?? data.length,
      rows: data.map(c => mapCall(c, { tz: config.tz, doctorNames }))
    });
  });

  r.post('/', async (req, res) => {
    const { db, config } = req.ctx;
    const d = parse(callSchema, req.body);
    let doctor = null;
    if (d.doctorId) {
      doctor = await must(db.from('doctors').select('id,branch').eq('id', d.doctorId).maybeSingle());
      if (!doctor) throw new UserError('اختر الطبيب من القائمة');
    }
    const row = await must(db.from('call_queue').insert({
      file_no: normalizeFileNo(d.fileNo),
      phone: requirePhone(d.phone),
      doctor_id: doctor ? doctor.id : null,
      branch: normalizeBranch(d.branch) || (doctor && BRANCHES.includes(doctor.branch) ? doctor.branch : null),
      visit_at: visitInstant(d.visitDate, d.visitTime, config.tz),
      updated_by: req.user.username
    }).select('id').single()).catch(e => {
      if (e.code === '23505') throw new UserError('هذه الزيارة موجودة في القائمة', 409);
      throw e;
    });
    await audit(db, req.user.username, 'add_call', row.id);
    res.status(201).json({ ok: true, id: row.id });
  });

  /** Bulk import (rows pasted from Excel). Bad rows are reported back by line; duplicates are skipped. */
  r.post('/import', requirePerm('importCalls'), async (req, res) => {
    const { db, config } = req.ctx;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) throw new UserError('لا توجد صفوف للاستيراد');
    if (rows.length > IMPORT_MAX) throw new UserError(`الحد الأقصى ${IMPORT_MAX} صف في المرة`);
    const doctors = await must(db.from('doctors').select('id,name,branch'));
    const byKey = new Map(doctors.map(d => [doctorKey(d.name), d]));
    const good = new Map();
    const errors = [];
    rows.forEach((raw, i) => {
      try {
        const doctor = raw.doctor ? byKey.get(doctorKey(raw.doctor)) || null : null;
        const item = {
          file_no: normalizeFileNo(raw.fileNo),
          phone: requirePhone(raw.phone),
          doctor_id: doctor ? doctor.id : null,
          doctor_name_raw: doctor ? null : String(raw.doctor || '').trim().slice(0, 80) || null,
          branch: normalizeBranch(raw.branch) || (doctor && BRANCHES.includes(doctor.branch) ? doctor.branch : null),
          visit_at: visitInstant(raw.visitDate, raw.visitTime, config.tz),
          updated_by: req.user.username
        };
        good.set(`${item.file_no}|${item.visit_at}`, item);
      } catch (e) {
        if (!e.userMessage) throw e;
        errors.push({ line: i + 1, error: e.message });
      }
    });
    let inserted = 0;
    if (good.size) {
      const out = await must(db.from('call_queue')
        .upsert([...good.values()], { onConflict: 'file_no,visit_at', ignoreDuplicates: true })
        .select('id'));
      inserted = out.length;
    }
    await audit(db, req.user.username, 'import_calls', `rows=${rows.length} inserted=${inserted} errors=${errors.length}`);
    res.json({ ok: true, received: rows.length, inserted, duplicates: good.size - inserted, errors: errors.slice(0, 50), errorCount: errors.length });
  });

  r.patch('/:id', async (req, res) => {
    const { db } = req.ctx;
    if (!UUID_RE.test(req.params.id)) throw new UserError('سجل الاتصال غير موجود', 404);
    const status = req.body?.status;
    if (!CALL_OUTCOMES.includes(status)) throw new UserError('قيمة غير صالحة: نتيجة الاتصال');
    const call = await must(db.from('call_queue').select('id,status,attempts').eq('id', req.params.id).maybeSingle());
    if (!call) throw new UserError('سجل الاتصال غير موجود', 404);
    if (call.status === 'تم') throw new UserError('هذا الاتصال مكتمل');
    const patch = { status, updated_by: req.user.username };
    if (status !== 'بانتظار الاتصال') {
      patch.attempts = (call.attempts || 0) + 1;
      patch.last_attempt_at = new Date().toISOString();
    }
    await must(db.from('call_queue').update(patch).eq('id', call.id));
    await audit(db, req.user.username, 'call_outcome', `${call.id} -> ${status}`);
    res.json({ ok: true });
  });

  return r;
}

function requirePhone(v) {
  const p = normalizePhone(v);
  if (!p) throw new UserError('رقم الجوال مطلوب للاتصال');
  return p;
}

module.exports = callRoutes;
module.exports.parseDate = parseDate;
module.exports.parseTime = parseTime;
