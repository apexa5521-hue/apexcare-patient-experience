'use strict';

const express = require('express');
const { z } = require('zod');
const { must, fetchAll, audit } = require('../db');
const { can, requirePerm, branchScope, assertBranch, ROLE_LABELS } = require('../access');
const { formatLocal, localToUtc, addDays } = require('../time');
const { UserError, UUID_RE, BRANCHES, maskPhone, parse, parseFilters } = require('../validate');
const C = require('../cases');
const { QUESTIONS } = require('../ratings');

const LIST_LIMIT = 500;

const isOverdue = (c, now = Date.now()) => c.status !== 'مغلقة' && c.due_at && new Date(c.due_at).getTime() < now;
const hoursBetween = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 3600000 : null);

async function lookupNames(db) {
  const [users, doctors] = await Promise.all([
    must(db.from('app_users').select('id,name,username,role,branch,active')),
    must(db.from('doctors').select('id,name'))
  ]);
  return { users, userById: new Map(users.map(u => [u.id, u])), doctorNames: new Map(doctors.map(d => [d.id, d.name])) };
}

function mapCase(c, user, { tz, userById, doctorNames }) {
  const a = c.assigned_to ? userById.get(c.assigned_to) : null;
  return {
    id: c.id, source: c.source, sourceId: c.source_id, createdAt: formatLocal(c.created_at, tz),
    branch: c.branch || '', doctorId: c.doctor_id, doctor: (c.doctor_id && doctorNames.get(c.doctor_id)) || '',
    fileNo: c.file_no || '', phone: can(user, 'fullPhones') ? c.phone || '' : maskPhone(c.phone),
    summary: c.summary || '', category: c.category || '', severity: c.severity, status: c.status,
    assignedTo: a ? { id: a.id, name: a.name } : null, mine: c.assigned_to === user.id,
    dueAt: formatLocal(c.due_at, tz), overdue: isOverdue(c),
    firstResponseAt: formatLocal(c.first_response_at, tz), closedAt: formatLocal(c.closed_at, tz),
    closeReason: c.close_reason || '', resolution: c.resolution || '', closedBy: c.closed_by || '', approvedBy: c.approved_by || ''
  };
}

/** Branch-scoped users see their branch plus cases with no branch yet; case officers only their own or unassigned. */
function visibleTo(user, c) {
  if (user.role === 'case_officer' && c.assigned_to && c.assigned_to !== user.id) return false;
  const scope = branchScope(user);
  return !scope || !c.branch || c.branch === scope;
}

async function loadCase(req, id) {
  if (!UUID_RE.test(id)) throw new UserError('الحالة غير موجودة', 404);
  const c = await must(req.ctx.db.from('cases').select('*').eq('id', id).maybeSingle());
  if (!c || !visibleTo(req.user, c)) throw new UserError('الحالة غير موجودة', 404);
  return c;
}

/**
 * For acting on a case. Contacting the patient or closing an unassigned case makes the actor its
 * owner (so workload is attributed); a case officer takes it on any action.
 */
async function loadForAction(req, id, { claim = false } = {}) {
  const c = await loadCase(req, id);
  if (!can(req.user, 'handleCases')) throw new UserError('لا تملك صلاحية لهذا الإجراء', 403);
  assertBranch(req.user, c.branch);
  if (c.status === 'مغلقة') throw new UserError('الحالة مغلقة. أعد فتحها أولاً');
  if (!c.assigned_to && (claim || req.user.role === 'case_officer')) {
    await must(req.ctx.db.from('cases').update({ assigned_to: req.user.id }).eq('id', c.id));
    await C.addEvent(req.ctx.db, c.id, req.user.username, 'إسناد', { body: `استلمتها ${req.user.name}` });
    c.assigned_to = req.user.id;
  }
  return c;
}

async function update(req, c, patch) {
  const next = { ...c, ...patch, updated_at: new Date().toISOString() };
  await must(req.ctx.db.from('cases').update({ ...patch, updated_at: next.updated_at }).eq('id', c.id));
  const assignee = next.assigned_to ? await must(req.ctx.db.from('app_users').select('name').eq('id', next.assigned_to).maybeSingle()) : null;
  await C.syncSource(req.ctx.db, next, assignee && assignee.name);
  return next;
}

function caseRoutes() {
  const r = express.Router();
  r.use(requirePerm('viewCases'));

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const q = req.query;
    const f = parseFilters({ from: q.from, to: q.to, branch: q.branch });
    let query = db.from('cases').select('*');
    if (f.branch) query = query.eq('branch', f.branch);
    if (f.from) query = query.gte('created_at', localToUtc(f.from, '00:00', config.tz).toISOString());
    if (f.to) query = query.lt('created_at', localToUtc(addDays(f.to, 1), '00:00', config.tz).toISOString());
    const status = String(q.status || 'open');
    if (status === 'open') query = query.in('status', C.OPEN_STATUSES);
    else if (C.CASE_STATUSES.includes(status)) query = query.eq('status', status);
    else if (status !== 'all') throw new UserError('قيمة فلتر غير صالحة');
    if (q.source) { if (!C.SOURCES.includes(q.source)) throw new UserError('قيمة فلتر غير صالحة'); query = query.eq('source', q.source); }
    if (q.severity) query = query.eq('severity', String(q.severity));
    if (q.fileNo) query = query.ilike('file_no', `%${String(q.fileNo).replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20)}%`);

    let rows = await fetchAll(() => query.order('created_at', { ascending: false }).order('id'), 5000);
    rows = rows.filter(c => visibleTo(req.user, c));
    const counts = {
      open: rows.filter(c => c.status !== 'مغلقة').length,
      unassigned: rows.filter(c => c.status !== 'مغلقة' && !c.assigned_to).length,
      mine: rows.filter(c => c.status !== 'مغلقة' && c.assigned_to === req.user.id).length,
      overdue: rows.filter(c => isOverdue(c)).length,
      awaitingApproval: rows.filter(c => c.status === 'بانتظار الاعتماد').length
    };
    if (q.assigned === 'me') rows = rows.filter(c => c.assigned_to === req.user.id);
    else if (q.assigned === 'none') rows = rows.filter(c => !c.assigned_to);
    else if (q.assigned && UUID_RE.test(q.assigned)) rows = rows.filter(c => c.assigned_to === q.assigned);
    if (q.overdue === '1') rows = rows.filter(c => isOverdue(c));
    // Most urgent first: overdue, then high severity, then oldest.
    const sevRank = { 'عالية': 0, 'متوسطة': 1, 'بسيطة': 2 };
    rows.sort((a, b) => (isOverdue(b) - isOverdue(a)) || ((a.status === 'مغلقة') - (b.status === 'مغلقة')) ||
      (sevRank[a.severity] - sevRank[b.severity]) || String(a.created_at).localeCompare(String(b.created_at)));
    const names = await lookupNames(db);
    res.json({ ok: true, counts, total: rows.length, rows: rows.slice(0, LIST_LIMIT).map(c => mapCase(c, req.user, { tz: config.tz, ...names })) });
  });

  /** People a case can be assigned to (within the caller's branch scope). */
  r.get('/assignees', requirePerm('assignCases'), async (req, res) => {
    const scope = branchScope(req.user);
    const users = await must(req.ctx.db.from('app_users').select('id,name,role,branch,active').eq('active', true));
    const rows = users.filter(u => can(u, 'handleCases') && (!scope || !u.branch || u.branch === scope))
      .map(u => ({ id: u.id, name: u.name, role: ROLE_LABELS[u.role], branch: u.branch || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    res.json({ ok: true, rows });
  });

  r.get('/stats', async (req, res) => {
    const { db, config } = req.ctx;
    const f = parseFilters({ from: req.query.from, to: req.query.to, branch: req.query.branch });
    let query = db.from('cases').select('*');
    if (f.branch) query = query.eq('branch', f.branch);
    if (f.from) query = query.gte('created_at', localToUtc(f.from, '00:00', config.tz).toISOString());
    if (f.to) query = query.lt('created_at', localToUtc(addDays(f.to, 1), '00:00', config.tz).toISOString());
    const rows = (await fetchAll(() => query.order('created_at').order('id'))).filter(c => visibleTo(req.user, c));
    const { userById } = await lookupNames(db);
    const avg = (list) => { const v = list.filter(x => x !== null && x >= 0); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
    const group = (key, labels) => labels.map(k => {
      const list = rows.filter(c => (c[key] || '') === k);
      return { key: k, total: list.length, open: list.filter(c => c.status !== 'مغلقة').length, overdue: list.filter(c => isOverdue(c)).length,
        avgFirstResponseH: avg(list.map(c => hoursBetween(c.created_at, c.first_response_at))), avgCloseH: avg(list.map(c => hoursBetween(c.created_at, c.closed_at))) };
    }).filter(g => g.total);
    const closed = rows.filter(c => c.status === 'مغلقة');
    const onTime = closed.filter(c => c.due_at && c.closed_at && c.closed_at <= c.due_at).length;
    const assignees = [...new Set(rows.map(c => c.assigned_to).filter(Boolean))].map(id => {
      const list = rows.filter(c => c.assigned_to === id);
      const u = userById.get(id);
      return { id, name: u ? u.name : '—', open: list.filter(c => c.status !== 'مغلقة').length, closed: list.filter(c => c.status === 'مغلقة').length,
        overdue: list.filter(c => isOverdue(c)).length, avgCloseH: avg(list.map(c => hoursBetween(c.created_at, c.closed_at))) };
    }).sort((a, b) => b.open - a.open);
    res.json({
      ok: true,
      stats: {
        total: rows.length, open: rows.length - closed.length, closed: closed.length, overdue: rows.filter(c => isOverdue(c)).length,
        unassigned: rows.filter(c => c.status !== 'مغلقة' && !c.assigned_to).length,
        awaitingApproval: rows.filter(c => c.status === 'بانتظار الاعتماد').length,
        avgFirstResponseH: avg(rows.map(c => hoursBetween(c.created_at, c.first_response_at))),
        avgCloseH: avg(closed.map(c => hoursBetween(c.created_at, c.closed_at))),
        onTimePct: closed.length ? Math.round((onTime / closed.length) * 100) : null,
        bySource: group('source', C.SOURCES), byBranch: group('branch', [...BRANCHES, '']), bySeverity: group('severity', ['عالية', 'متوسطة', 'بسيطة']),
        closeReasons: C.CLOSE_REASONS.map(k => ({ key: k, count: closed.filter(c => c.close_reason === k).length })).filter(x => x.count),
        assignees
      }
    });
  });

  r.get('/:id', async (req, res) => {
    const { db, config } = req.ctx;
    const c = await loadCase(req, req.params.id);
    const [events, names] = await Promise.all([
      must(db.from('case_events').select('*').eq('case_id', c.id).order('at').order('id')),
      lookupNames(db)
    ]);
    let detail = null;
    if (c.source === 'تجربة سلبية') {
      const e = await must(db.from('experiences').select('visit_at,visit_type,channel,booking_rating,reception_rating,plan_explained,doctor_rating,general_note,category').eq('id', c.source_id).maybeSingle());
      if (e) detail = { visitAt: formatLocal(e.visit_at, config.tz), visitType: e.visit_type, channel: e.channel, bookingRating: e.booking_rating,
        receptionRating: e.reception_rating, planExplained: e.plan_explained, doctorRating: e.doctor_rating, note: e.general_note || '' };
    } else if (c.source === 'شكوى') {
      const k = await must(db.from('complaints').select('description,source,created_at').eq('id', c.source_id).maybeSingle());
      if (k) detail = { text: k.description, channel: k.source, at: formatLocal(k.created_at, config.tz) };
    } else if (c.source === 'تقييم خدمة') {
      const x = await must(db.from('service_ratings').select('*').eq('id', c.source_id).maybeSingle());
      if (x) detail = { at: formatLocal(x.created_at, config.tz), visitAt: formatLocal(x.visit_at, config.tz), comment: x.comment || '',
        answers: QUESTIONS.map(q => ({ label: q.label, score: x[q.key] })) };
    } else if (c.source === 'تقييم قوقل') {
      const g = await must(db.from('google_reviews').select('rating,comment,reply,created_at').eq('id', c.source_id).maybeSingle());
      if (g) detail = { rating: g.rating, text: g.comment || '', reply: g.reply || '', at: formatLocal(g.created_at, config.tz) };
    }
    res.json({
      ok: true,
      case: mapCase(c, req.user, { tz: config.tz, ...names }),
      detail,
      events: events.map(e => ({ id: e.id, at: formatLocal(e.at, config.tz), username: e.username, type: e.type, outcome: e.outcome || '', body: e.body || '' })),
      can: {
        act: can(req.user, 'handleCases') && c.status !== 'مغلقة',
        assign: can(req.user, 'assignCases'),
        approve: can(req.user, 'approveCases') && c.status === 'بانتظار الاعتماد',
        reopen: can(req.user, 'assignCases') && c.status === 'مغلقة',
        closeNeedsApproval: c.severity === 'عالية' && !can(req.user, 'approveCases')
      }
    });
  });

  r.post('/:id/assign', requirePerm('assignCases'), async (req, res) => {
    const c = await loadCase(req, req.params.id);
    assertBranch(req.user, c.branch);
    const userId = req.body?.userId || null;
    let name = 'بدون';
    if (userId) {
      const u = await must(req.ctx.db.from('app_users').select('id,name,role,active,branch').eq('id', String(userId)).maybeSingle());
      if (!u || !u.active || !can(u, 'handleCases')) throw new UserError('اختر موظفاً يملك صلاحية المتابعة');
      name = u.name;
    }
    await update(req, c, { assigned_to: userId });
    await C.addEvent(req.ctx.db, c.id, req.user.username, 'إسناد', { body: `أُسندت إلى: ${name}` });
    res.json({ ok: true });
  });

  r.post('/:id/events', async (req, res) => {
    const d = parse(z.object({
      type: z.string().refine(v => ['ملاحظة', 'اتصال', 'واتساب', 'رسالة'].includes(v), 'نوع غير صالح'),
      outcome: z.preprocess(v => v || null, z.string().refine(v => C.CONTACT_OUTCOMES.includes(v), 'اختر نتيجة التواصل').nullable()),
      body: z.preprocess(v => (v ?? ''), z.string().trim().max(2000, 'الملاحظة طويلة (الحد 2000 حرف)'))
    }).refine(x => x.type === 'ملاحظة' ? x.body.length > 0 : !!x.outcome, { message: 'اكتب الملاحظة أو اختر نتيجة التواصل' }), req.body);
    const c = await loadForAction(req, req.params.id, { claim: d.type !== 'ملاحظة' });
    await C.addEvent(req.ctx.db, c.id, req.user.username, d.type, { outcome: d.outcome, body: d.body || null });
    const patch = {};
    if (d.type !== 'ملاحظة' && !c.first_response_at) patch.first_response_at = new Date().toISOString();
    if (c.status === 'جديدة') patch.status = 'قيد المعالجة';
    if (Object.keys(patch).length) await update(req, c, patch);
    if (patch.status) await C.addEvent(req.ctx.db, c.id, req.user.username, 'حالة', { body: 'جديدة ← قيد المعالجة' });
    res.status(201).json({ ok: true });
  });

  r.post('/:id/status', async (req, res) => {
    const status = req.body?.status;
    if (!['قيد المعالجة', 'بانتظار المريض'].includes(status)) throw new UserError('حالة غير صالحة');
    const c = await loadForAction(req, req.params.id);
    if (c.status === 'بانتظار الاعتماد') throw new UserError('الحالة بانتظار اعتماد الإقفال');
    if (c.status === status) return res.json({ ok: true });
    await update(req, c, { status });
    await C.addEvent(req.ctx.db, c.id, req.user.username, 'حالة', { body: `${c.status} ← ${status}`, outcome: null });
    res.json({ ok: true });
  });

  r.post('/:id/close', async (req, res) => {
    const d = parse(z.object({
      reason: z.string({ error: 'اختر سبب الإقفال' }).refine(v => C.CLOSE_REASONS.includes(v), 'اختر سبب الإقفال'),
      resolution: z.string({ error: 'اكتب ما تم' }).trim().min(1, 'اكتب ما تم').max(2000)
    }), req.body);
    const c = await loadForAction(req, req.params.id, { claim: true });
    if (c.status === 'بانتظار الاعتماد') throw new UserError('الحالة بانتظار اعتماد الإقفال');
    const needsApproval = c.severity === 'عالية' && !can(req.user, 'approveCases');
    const now = new Date().toISOString();
    if (needsApproval) {
      await update(req, c, { status: 'بانتظار الاعتماد', close_reason: d.reason, resolution: d.resolution, closed_by: req.user.username });
      await C.addEvent(req.ctx.db, c.id, req.user.username, 'حالة', { body: `طلب إقفال (${d.reason}): ${d.resolution}` });
    } else {
      await update(req, c, { status: 'مغلقة', close_reason: d.reason, resolution: d.resolution, closed_at: now, closed_by: req.user.username });
      await C.addEvent(req.ctx.db, c.id, req.user.username, 'حالة', { body: `أُقفلت (${d.reason}): ${d.resolution}` });
    }
    await audit(req.ctx.db, req.user.username, needsApproval ? 'case_close_request' : 'case_close', c.id);
    res.json({ ok: true, status: needsApproval ? 'بانتظار الاعتماد' : 'مغلقة' });
  });

  r.post('/:id/approve', requirePerm('approveCases'), async (req, res) => {
    const approve = req.body?.approve === true;
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    const c = await loadCase(req, req.params.id);
    assertBranch(req.user, c.branch);
    if (c.status !== 'بانتظار الاعتماد') throw new UserError('لا يوجد طلب إقفال لهذه الحالة');
    if (approve) {
      await update(req, c, { status: 'مغلقة', closed_at: new Date().toISOString(), approved_by: req.user.username });
      await C.addEvent(req.ctx.db, c.id, req.user.username, 'اعتماد', { outcome: 'معتمد', body: note || null });
    } else {
      if (!note) throw new UserError('اكتب سبب الإرجاع');
      await update(req, c, { status: 'قيد المعالجة', close_reason: null, closed_by: null });
      await C.addEvent(req.ctx.db, c.id, req.user.username, 'اعتماد', { outcome: 'أُرجعت', body: note });
    }
    await audit(req.ctx.db, req.user.username, approve ? 'case_approve' : 'case_return', c.id);
    res.json({ ok: true });
  });

  r.post('/:id/reopen', requirePerm('assignCases'), async (req, res) => {
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    if (!note) throw new UserError('اكتب سبب إعادة الفتح');
    const c = await loadCase(req, req.params.id);
    assertBranch(req.user, c.branch);
    if (c.status !== 'مغلقة') throw new UserError('الحالة ليست مغلقة');
    await update(req, c, { status: 'قيد المعالجة', closed_at: null, approved_by: null });
    await C.addEvent(req.ctx.db, c.id, req.user.username, 'حالة', { body: `أُعيد فتحها: ${note}` });
    res.json({ ok: true });
  });

  return r;
}

module.exports = caseRoutes;
