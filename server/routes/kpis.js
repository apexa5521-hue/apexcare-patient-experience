'use strict';

const express = require('express');
const { must, fetchAll } = require('../db');
const { computeKpis } = require('../kpis');
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
    res.json({ ok: true, kpis });
  });
  return r;
}

module.exports = kpiRoutes;
