'use strict';

const express = require('express');
const { must, audit } = require('../db');
const { isAdmin, requireAdmin } = require('../auth');
const { localToUtc } = require('../time');
const { applyExperienceFilters, mapExperience } = require('../queries');
const {
  UserError, UUID_RE, parse, parseFilters, normalizeFileNo, normalizePhone, experienceSchema, followUpSchema
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

function experienceRoutes() {
  const r = express.Router();

  r.post('/', async (req, res) => {
    const { db, config } = req.ctx;
    const d = parse(experienceSchema, req.body);
    const fileNo = normalizeFileNo(d.fileNo);
    const phone = normalizePhone(d.phone);

    const visitAt = localToUtc(d.visitDate, d.visitTime, config.tz);
    if (visitAt.getTime() > Date.now() + FUTURE_GRACE_MS) throw new UserError('وقت الزيارة لا يمكن أن يكون في المستقبل');

    const doctor = await must(db.from('doctors').select('*').eq('id', d.doctorId).maybeSingle());
    if (!doctor || !doctor.active) throw new UserError('اختر الطبيب من القائمة');
    if (doctor.branch !== 'الكل' && doctor.branch !== d.branch) throw new UserError('الطبيب المختار لا يعمل في هذا الفرع');

    const negative = d.sentiment === 'سلبية';
    let category = null;
    if (d.category && d.sentiment !== 'محايدة') {
      const allowed = negative ? ['سلبية', 'الكل'] : ['إيجابية', 'الكل'];
      const cat = await must(db.from('categories').select('*').eq('name', d.category).maybeSingle());
      if (!cat || !cat.active || !allowed.includes(cat.type)) throw new UserError('التصنيف غير موجود في القائمة');
      category = cat.name;
    }

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
      created_by: req.user.id
    }).select('id').single());

    await audit(db, req.user.username, 'add_experience', row.id);
    res.status(201).json({ ok: true, id: row.id });
  });

  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const admin = isAdmin(req.user);
    const f = parseFilters(req.query);
    let q = db.from('experiences').select('*', { count: 'exact' });
    q = applyExperienceFilters(q, f, config.tz);
    if (!admin) q = q.eq('created_by', req.user.id);
    const { data, count } = await must(q.order('visit_at', { ascending: false }).range(0, LIST_LIMIT - 1));
    const maps = await nameMaps(db, admin);
    res.json({
      ok: true,
      total: count ?? data.length,
      limit: LIST_LIMIT,
      rows: data.map(e => mapExperience(e, { admin, tz: config.tz, ...maps }))
    });
  });

  r.patch('/:id/follow-up', requireAdmin, async (req, res) => {
    const { db } = req.ctx;
    if (!UUID_RE.test(req.params.id)) throw new UserError('السجل غير موجود', 404);
    const { followUp } = parse(followUpSchema, req.body);
    const e = await must(db.from('experiences').select('id,sentiment').eq('id', req.params.id).maybeSingle());
    if (!e) throw new UserError('السجل غير موجود', 404);
    if (e.sentiment !== 'سلبية') throw new UserError('المتابعة للتجارب السلبية فقط');
    await must(db.from('experiences').update({ follow_up: followUp }).eq('id', e.id));
    await audit(db, req.user.username, 'update_follow_up', `${e.id} -> ${followUp}`);
    res.json({ ok: true });
  });

  return r;
}

module.exports = experienceRoutes;
module.exports.nameMaps = nameMaps;
