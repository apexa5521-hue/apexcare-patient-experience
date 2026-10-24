'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { must, countOf, audit } = require('../db');
const { isAdmin, requireAdmin } = require('../auth');
const { isOverdue } = require('../kpis');
const { applyComplaintFilters, mapComplaint } = require('../queries');
const {
  UserError, UUID_RE, BRANCHES, SEVERITIES, normalizeBranch, parse, parseFilters, normalizeFileNo, normalizePhone, tryPhone,
  complaintSchema, complaintUpdateSchema
} = require('../validate');

const LIST_LIMIT = 500;
const WEBHOOK_MAX_ROWS = 100;
const SHEET_SOURCE = 'شيت الشكاوى';

async function doctorNameMap(db) {
  const doctors = await must(db.from('doctors').select('id,name'));
  return new Map(doctors.map(d => [d.id, d.name]));
}

async function summary(db, overdueDays) {
  const cutoff = new Date(Date.now() - overdueDays * 86400000).toISOString();
  const head = () => db.from('complaints').select('id', { count: 'exact', head: true });
  const [total, open, overdue] = await Promise.all([
    countOf(head()),
    countOf(head().neq('status', 'مغلقة')),
    countOf(head().neq('status', 'مغلقة').lt('created_at', cutoff))
  ]);
  return { total, open, overdue };
}

function complaintRoutes() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const admin = isAdmin(req.user);
    const f = parseFilters(req.query);
    let q = db.from('complaints').select('*', { count: 'exact' });
    q = applyComplaintFilters(q, f, config.tz);
    const [{ data, count }, sum, doctorNames] = await Promise.all([
      must(q.order('created_at', { ascending: false }).range(0, LIST_LIMIT - 1)),
      summary(db, config.overdueDays),
      doctorNameMap(db)
    ]);
    const now = new Date();
    res.json({
      ok: true,
      summary: sum,
      total: count ?? data.length,
      limit: LIST_LIMIT,
      rows: data.map(c => mapComplaint(c, { admin, tz: config.tz, doctorNames, overdue: isOverdue(c, now, config.overdueDays) }))
    });
  });

  r.post('/', async (req, res) => {
    const { db } = req.ctx;
    const d = parse(complaintSchema, req.body);
    if (d.doctorId) {
      const doc = await must(db.from('doctors').select('id,active').eq('id', d.doctorId).maybeSingle());
      if (!doc || !doc.active) throw new UserError('الطبيب غير موجود في القائمة');
    }
    const row = await must(db.from('complaints').insert({
      file_no: normalizeFileNo(d.fileNo),
      phone: normalizePhone(d.phone),
      doctor_id: d.doctorId,
      branch: d.branch,
      category: d.category,
      severity: d.severity,
      status: 'جديدة',
      description: d.description,
      source: 'إدخال يدوي',
      updated_by: req.user.username
    }).select('id').single());
    await audit(db, req.user.username, 'add_complaint', row.id);
    res.status(201).json({ ok: true, id: row.id });
  });

  r.patch('/:id', requireAdmin, async (req, res) => {
    const { db } = req.ctx;
    if (!UUID_RE.test(req.params.id)) throw new UserError('الشكوى غير موجودة', 404);
    const d = parse(complaintUpdateSchema, req.body);
    const c = await must(db.from('complaints').select('id,status,closed_at').eq('id', req.params.id).maybeSingle());
    if (!c) throw new UserError('الشكوى غير موجودة', 404);
    const closing = d.status === 'مغلقة';
    await must(db.from('complaints').update({
      status: d.status,
      assigned_to: d.assignedTo,
      resolution: d.resolution,
      // Keep the original close time if it was already closed; clear it on reopen.
      closed_at: closing ? c.closed_at || new Date().toISOString() : null,
      updated_by: req.user.username
    }).eq('id', c.id));
    await audit(db, req.user.username, 'update_complaint', `${c.id} -> ${d.status}`);
    res.json({ ok: true });
  });

  return r;
}

/* ---------- complaints sheet webhook ---------- */

function sameSecret(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Loose doctor-name key: drops titles and unifies common Arabic letter variants. */
function doctorKey(name) {
  return String(name || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/^\s*(الدكتوره|الدكتور|دكتوره|دكتور|د\s*[./]|د\s+|dr\.?\s*)/i, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanText(v, max) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function parseSheetDate(v) {
  const t = v ? new Date(v) : null;
  if (!t || Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 86400000) return new Date().toISOString();
  return t.toISOString();
}

/**
 * Only whitelisted fields are read from each row. Anything else the sheet sends
 * (e.g. a patient-name column) is dropped here and never stored.
 */
function sheetRowToComplaint(row, doctorsByKey) {
  const description = cleanText(row.description, 2000);
  const sourceKey = cleanText(row.source_key, 200);
  if (!description || !sourceKey) return null;
  const doctorRaw = cleanText(row.doctor, 80);
  const doctor = doctorRaw ? doctorsByKey.get(doctorKey(doctorRaw)) || null : null;
  const doctorId = doctor ? doctor.id : null;
  const fileNo = cleanText(row.file_no, 40);
  // Sheet branch in any spelling; else the matched doctor's branch when they work in only one.
  const branch = normalizeBranch(row.branch) || (doctor && BRANCHES.includes(doctor.branch) ? doctor.branch : null);
  const severity = cleanText(row.severity, 20);
  return {
    source_key: sourceKey,
    created_at: parseSheetDate(row.date),
    file_no: fileNo ? fileNo.replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20) || null : null,
    phone: tryPhone(row.phone),
    doctor_id: doctorId,
    doctor_name_raw: doctorId ? null : doctorRaw,
    branch,
    category: cleanText(row.category, 80),
    severity: SEVERITIES.includes(severity) ? severity : 'متوسطة',
    status: 'جديدة',
    description,
    source: SHEET_SOURCE,
    updated_by: 'sheet'
  };
}

function webhookRoutes() {
  const r = express.Router();
  r.post('/complaints', async (req, res) => {
    const { db, config } = req.ctx;
    if (!sameSecret(req.get('x-webhook-secret'), config.webhookSecret)) throw new UserError('غير مصرّح', 401);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) throw new UserError('صيغة الطلب غير صالحة');
    if (rows.length > WEBHOOK_MAX_ROWS) throw new UserError(`الحد الأقصى ${WEBHOOK_MAX_ROWS} صفاً في الطلب`);

    const doctors = await must(db.from('doctors').select('id,name,branch'));
    const doctorsByKey = new Map(doctors.map(d => [doctorKey(d.name), d]));
    const unique = new Map();
    for (const row of rows) {
      const c = row && typeof row === 'object' ? sheetRowToComplaint(row, doctorsByKey) : null;
      if (c && !unique.has(c.source_key)) unique.set(c.source_key, c);
    }
    let inserted = 0;
    if (unique.size) {
      // ignoreDuplicates: a re-sent row never overwrites status/resolution set by the admins.
      const out = await must(db.from('complaints')
        .upsert([...unique.values()], { onConflict: 'source_key', ignoreDuplicates: true })
        .select('id'));
      inserted = out.length;
    }
    await audit(db, 'sheet', 'webhook_complaints', `received=${rows.length} inserted=${inserted}`);
    res.json({ ok: true, received: rows.length, accepted: unique.size, inserted });
  });
  return r;
}

module.exports = { complaintRoutes, webhookRoutes, doctorKey, sheetRowToComplaint };
