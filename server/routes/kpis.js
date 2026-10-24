'use strict';

const express = require('express');
const { must, fetchAll } = require('../db');
const { computeKpis, computeServiceRatings } = require('../kpis');
const { QUESTIONS } = require('../ratings');
const { localToUtc, addDays } = require('../time');
const { parseFilters } = require('../validate');
const { branchScope } = require('../access');
const { applyExperienceFilters, applyComplaintFilters } = require('../queries');

const EX_COLS = 'id,visit_at,doctor_id,branch,sentiment,category,severity,booking_rating,reception_rating,plan_explained,doctor_rating,channel';
const CO_COLS = 'id,created_at,closed_at,status,doctor_id,category,branch';

function kpiRoutes() {
  const r = express.Router();
  r.get('/', async (req, res) => {
    const { db, config } = req.ctx;
    const f = parseFilters(req.query);
    const scope = branchScope(req.user);
    if (scope) f.branch = scope;
    const [experiences, complaints, allDoctors] = await Promise.all([
      fetchAll(() => applyExperienceFilters(db.from('experiences').select(EX_COLS), f, config.tz).order('visit_at').order('id')),
      // Complaints carry no visit time or visit type, so only date/branch/doctor apply to them.
      fetchAll(() => applyComplaintFilters(db.from('complaints').select(CO_COLS), { from: f.from, to: f.to, branch: f.branch, doctorId: f.doctorId }, config.tz).order('created_at').order('id')),
      must(db.from('doctors').select('id,name,specialty,branch,active'))
    ]);
    const referenced = new Set([...experiences, ...complaints].map(x => x.doctor_id).filter(Boolean));
    const doctors = allDoctors.filter(d => referenced.has(d.id) || (
      d.active && (!f.doctorId || d.id === f.doctorId) && (!f.branch || d.branch === f.branch || d.branch === 'الكل')
    ));
    const kpis = computeKpis({ experiences, complaints, doctors, tz: config.tz, overdueDays: config.overdueDays });

    // Other patient-voice sources over the same dates/branch (time-of-day, doctor and visit filters don't apply to them).
    const ranged = (q, col) => {
      if (f.from) q = q.gte(col, localToUtc(f.from, '00:00', config.tz).toISOString());
      if (f.to) q = q.lt(col, localToUtc(addDays(f.to, 1), '00:00', config.tz).toISOString());
      if (f.branch) q = q.eq('branch', f.branch);
      return q;
    };
    const [ratings, reviews] = await Promise.all([
      fetchAll(() => ranged(db.from('service_ratings').select('*'), 'created_at').order('created_at').order('id')),
      fetchAll(() => ranged(db.from('google_reviews').select('id,rating,branch,reply'), 'created_at').order('created_at').order('id'))
    ]);
    kpis.serviceRatings = computeServiceRatings(ratings, QUESTIONS);
    const rated = reviews.filter(r => r.rating);
    const byChannel = Object.fromEntries(kpis.byChannel.map(c => [c.channel, c]));
    kpis.sources = {
      phone: byChannel['اتصال'] ? { total: byChannel['اتصال'].total, negPct: byChannel['اتصال'].negPct, avgDoctor: byChannel['اتصال'].avgDoctor } : { total: 0 },
      inPerson: byChannel['حضوري'] ? { total: byChannel['حضوري'].total, negPct: byChannel['حضوري'].negPct, avgDoctor: byChannel['حضوري'].avgDoctor } : { total: 0 },
      complaints: { total: kpis.summary.complaints, open: kpis.summary.openComplaints },
      serviceRatings: { total: ratings.length, avgOverall: kpis.serviceRatings.questions.find(q => q.key === 'q_overall').avg, low: kpis.serviceRatings.lowCount },
      google: { total: reviews.length, avg: rated.length ? Math.round((rated.reduce((a, r) => a + r.rating, 0) / rated.length) * 100) / 100 : null,
        unreplied: reviews.filter(r => !r.reply).length }
    };
    res.json({ ok: true, kpis });
  });
  return r;
}

module.exports = kpiRoutes;
