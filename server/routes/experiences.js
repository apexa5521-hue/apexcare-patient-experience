'use strict';

const express = require('express');
const { must, audit } = require('../db');
const { can, branchScope, requirePerm, assertBranch } = require('../access');
const { openCases, caseIdsFor, addEvent } = require('../cases');
const { localToUtc } = require('../time');
const { applyExperienceFilters, mapExperience } = require('../queries');
const {
  UserError, parse, parseFilters, normalizeFileNo, normalizePhone, experienceSchema
} = require('../validate');

const LIST_LIMIT = 500;
const FUTURE_GRACE_MS = 15 * 60 * 1000;

async function nameMaps(db, admin) {
  const [doctors, users] = await Promise.all([
    must(db.from('doctors').select('id,name')),
    admin ? must(db.from('app_users').select('id,username')) : []
  ]);
  return {
    doctorNames: new Map(doctors.map(d => [d.id, d.name])),
    usernames: new Map(users.map(u => [u.id, u.username]))
  };
}

/** Who may change a recorded experience: the person who recorded it, or quality and managers. */
function canEdit(user, e) {
  return (can(user, 'record') && e.created_by === user.id) || can(user, 'editAnyExperience');
}

/** Checks the doctor and the category for a form submission. `keepDoctorId` allows a doctor deactivated since. */
async function checkDoctorAndCategory(db, d, keepDoctorId = null) {
  const doctor = await must(db.from('doctors').select('*').eq('id', d.doctorId).maybeSingle());
  if (!doctor || (!doctor.active && doctor.id !== keepDoctorId)) throw new UserError('اختر الطبيب من القائمة');
  if (doctor.branch !== 'الكل' && doctor.branch !== d.branch) throw new UserError('الطبيب المختار لا يعمل في هذا الفرع');
  const negative = d.sentiment === 'سلبية';
  let category = null;
  if (d.category && d.sentiment !== 'محايدة') {
    const allowed = negative ? ['سلبية', 'الكل'] : ['إيجابية', 'الكل'];
    const cat = await must(db.from('categories').select('*').eq('name', d.category).maybeSingle());
    if (!cat || !cat.active || !allowed.includes(cat.type)) throw new UserError('التصنيف غير موجود في القائمة');
    category = cat.name;
  }
  return { doctor, category, negative };
}

function experienceRoutes() {
  const r = express.Router();

  r.post('/', requirePerm('record'), async (req, res) => {
    const { db, config } = req.ctx;
    const d = parse(experienceSchema, req.body);
    const fileNo = normalizeFileNo(d.fileNo);
    const phone = normalizePhone(d.phone);

    const visitAt = localToUtc(d.visitDate, d.visitTime, config.tz);
    if (visitAt.getTime() > Date.now() + FUTURE_GRACE_MS) throw new UserError('وقت الزيارة لا يمكن أن يكون في المستقبل');

    let call = null;
    if (d.callId) {
      call = await must(db.from('call_queue').select('id,status').eq('id', d.callId).maybeSingle());
      if (!call) throw new UserError('سجل الاتصال غير موجود');
      if (call.status === 'تم') throw new UserError('هذا الاتصال سُجّل له تقييم من قبل');
    }

    const { doctor, category, negative } = await checkDoctorAndCategory(db, d);

    const row = await must(db.from('experiences').insert({
      visit_at: visitAt.toISOString(),
      file_no: fileNo,
      phone,
      doctor_id: doctor.id,
      branch: d.branch,
      specialty: doctor.specialty,
      visit_type: d.visitType,
      sentiment: d.sentiment,
      category,
      severity: negative ? d.severity : null,
      follow_up: negative ? 'جديدة' : null,
      booking_rating: d.bookingRating,
      reception_rating: d.receptionRating,
      plan_explained: d.planExplained,
      doctor_rating: d.doctorRating,
      general_note: d.generalNote,
      channel: call ? 'اتصال' : d.channel,
      created_by: req.user.id
    }).select('id').single());

    if (call) {
      await must(db.from('call_queue').update({
        status: 'تم', experience_id: row.id, last_attempt_at: new Date().toISOString(), updated_by: req.user.username
      }).eq('id', call.id));
    }
    if (negative) {
      await openCases(db, [{
        source: 'تجربة سلبية', source_id: row.id, branch: d.branch, doctor_id: doctor.id, file_no: fileNo, phone,
        summary: [category, d.generalNote].filter(Boolean).join(' — '), category, severity: d.severity
      }]);
    }
    await audit(db, req.user.username, 'add_experience', call ? `${row.id} (call ${call.id})` : row.id);
    res.status(201).json({ ok: true, id: row.id });
  });

  // Correct a recorded experience. The follow-up case follows: a newly negative experience opens one,
  // an open case takes the new details, and a case whose experience is no longer negative gets a note to review it.
  r.patch('/:id', async (req, res) => {
    const { db, config } = req.ctx;
    const old = await must(db.from('experiences').select('*').eq('id', String(req.params.id)).maybeSingle());
    if (!old) throw new UserError('التجربة غير موجودة', 404);
    if (!canEdit(req.user, old)) throw new UserError('لا تملك صلاحية تعديل هذه التجربة', 403);
    assertBranch(req.user, old.branch);
    const d = parse(experienceSchema, req.body);
    assertBranch(req.user, d.branch);
    const fileNo = normalizeFileNo(d.fileNo);
    // The list shows a masked number to roles without full phones; «keepPhone» leaves the stored one as it is.
    const phone = req.body.keepPhone === true && !d.phone ? old.phone : normalizePhone(d.phone);
    const visitAt = localToUtc(d.visitDate, d.visitTime, config.tz);
    if (visitAt.getTime() > Date.now() + FUTURE_GRACE_MS) throw new UserError('وقت الزيارة لا يمكن أن يكون في المستقبل');
    const { doctor, category, negative } = await checkDoctorAndCategory(db, d, old.doctor_id);

    const next = {
      visit_at: visitAt.toISOString(), file_no: fileNo, phone, doctor_id: doctor.id, branch: d.branch, specialty: doctor.specialty,
      visit_type: d.visitType, sentiment: d.sentiment, category, severity: negative ? d.severity : null,
      follow_up: negative ? old.follow_up || 'جديدة' : null,
      booking_rating: d.bookingRating, reception_rating: d.receptionRating, plan_explained: d.planExplained,
      doctor_rating: d.doctorRating, general_note: d.generalNote, channel: d.channel
    };
    const changed = Object.keys(next).filter(k => String(next[k] ?? '') !== String(old[k] ?? '')
      && !(k === 'visit_at' && new Date(old.visit_at).getTime() === visitAt.getTime()));
    if (!changed.length) return res.json({ ok: true, id: old.id, changed: [] });
    await must(db.from('experiences').update(next).eq('id', old.id));

    const kase = await must(db.from('cases').select('*').eq('source', 'تجربة سلبية').eq('source_id', String(old.id)).maybeSingle());
    const summary = [category, d.generalNote].filter(Boolean).join(' — ');
    if (negative && !kase) {
      await openCases(db, [{ source: 'تجربة سلبية', source_id: old.id, branch: d.branch, doctor_id: doctor.id, file_no: fileNo, phone, summary, category, severity: d.severity }]);
    } else if (kase && kase.status !== 'مغلقة') {
      if (negative) {
        await must(db.from('cases').update({ branch: d.branch, doctor_id: doctor.id, file_no: fileNo, phone, summary: summary.slice(0, 2000) || null,
          category, severity: d.severity, updated_at: new Date().toISOString() }).eq('id', kase.id));
        await addEvent(db, kase.id, req.user.username, 'نظام', { body: 'عُدّلت التجربة، وحُدّثت بيانات الحالة' });
      } else {
        await addEvent(db, kase.id, req.user.username, 'نظام', { body: `عُدّلت التجربة إلى «${d.sentiment}». راجع الحالة وأقفلها إن لم تعد مطلوبة` });
      }
    }
    await audit(db, req.user.username, 'update_experience', `${old.id} ${changed.join(',')}`);
    res.json({ ok: true, id: old.id, changed });
  });

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const seeAll = can(req.user, 'viewAllExperiences');
    const f = parseFilters(req.query);
    const scope = branchScope(req.user);
    if (scope) f.branch = scope;
    let q = db.from('experiences').select('*', { count: 'exact' });
    q = applyExperienceFilters(q, f, config.tz);
    if (!seeAll) q = q.eq('created_by', req.user.id);
    const { data, count } = await must(q.order('visit_at', { ascending: false }).range(0, LIST_LIMIT - 1));
    const [maps, caseIds] = await Promise.all([
      nameMaps(db, seeAll),
      caseIdsFor(db, 'تجربة سلبية', data.filter(e => e.sentiment === 'سلبية').map(e => e.id))
    ]);
    res.json({
      ok: true,
      total: count ?? data.length,
      limit: LIST_LIMIT,
      rows: data.map(e => ({
        ...mapExperience(e, { admin: seeAll, fullPhone: can(req.user, 'fullPhones'), tz: config.tz, ...maps }),
        caseId: caseIds.get(e.id) || null,
        canEdit: canEdit(req.user, e)
      }))
    });
  });

  return r;
}

module.exports = experienceRoutes;
module.exports.nameMaps = nameMaps;
