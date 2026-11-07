'use strict';

const express = require('express');
const { must, fetchAll } = require('../db');
const { computeKpis, computeServiceRatings } = require('../kpis');
const { QUESTIONS } = require('../ratings');
const { localToUtc, addDays, localParts } = require('../time');
const { loadSettings } = require('../crm');
const { parseFilters } = require('../validate');
const { branchScope, can } = require('../access');
const { applyExperienceFilters, applyComplaintFilters } = require('../queries');

const EX_COLS = 'id,visit_at,doctor_id,branch,sentiment,category,severity,booking_rating,reception_rating,plan_explained,doctor_rating,channel';
const CO_COLS = 'id,created_at,closed_at,status,doctor_id,category,branch';

function kpiRoutes() {
  const r = express.Router();

  // «تجارب اليوم»: each employee's call-survey experiences on one day against the daily minimum, and how their calls went.
  r.get('/today', async (req, res) => {
    const { db, config } = req.ctx;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : localParts(new Date(), config.tz).date;
    const start = localToUtc(date, '00:00', config.tz).toISOString(), end = localToUtc(addDays(date, 1), '00:00', config.tz).toISOString();
    const scope = branchScope(req.user);
    let exq = db.from('experiences').select('id,created_by,branch,sentiment,doctor_rating').eq('channel', 'اتصال').gte('created_at', start).lt('created_at', end);
    let cq = db.from('call_queue').select('id,status,updated_by,branch').in('status', ['لم يرد', 'رفض', 'رقم خاطئ']).gte('last_attempt_at', start).lt('last_attempt_at', end);
    if (scope) { exq = exq.eq('branch', scope); cq = cq.eq('branch', scope); }
    const [settings, users, experiences, calls] = await Promise.all([
      loadSettings(db),
      must(db.from('app_users').select('id,username,name,role,branch,active')),
      fetchAll(() => exq.order('created_at').order('id')),
      fetchAll(() => cq.order('id'))
    ]);
    const target = settings.dailyMinPerStaff;
    const byUser = new Map();
    const entry = (u) => {
      if (!byUser.has(u.id)) byUser.set(u.id, { id: u.id, username: u.username, name: u.name, branch: u.branch || '', done: 0, negative: 0, ratingSum: 0, ratingN: 0, noAnswer: 0, refused: 0, wrongNumber: 0 });
      return byUser.get(u.id);
    };
    // Everyone who makes survey calls is listed, even with nothing yet today.
    users.filter(u => u.active && can(u, 'calls') && u.role !== 'admin' && (!scope || !u.branch || u.branch === scope)).forEach(entry);
    const byId = new Map(users.map(u => [u.id, u])), byName = new Map(users.map(u => [u.username, u]));
    for (const e of experiences) {
      const u = byId.get(e.created_by); if (!u) continue;
      const x = entry(u);
      x.done++;
      if (e.sentiment === 'سلبية') x.negative++;
      if (e.doctor_rating) { x.ratingSum += Number(e.doctor_rating); x.ratingN++; }
    }
    for (const c of calls) {
      const u = byName.get(c.updated_by); if (!u) continue;
      const x = entry(u);
      if (c.status === 'لم يرد') x.noAnswer++; else if (c.status === 'رفض') x.refused++; else x.wrongNumber++;
    }
    const staff = [...byUser.values()].map(x => ({
      id: x.id, username: x.username, name: x.name, branch: x.branch, done: x.done, target, met: x.done >= target,
      pct: Math.min(100, Math.round((x.done / target) * 100)), negative: x.negative, noAnswer: x.noAnswer, refused: x.refused, wrongNumber: x.wrongNumber,
      avgDoctor: x.ratingN ? Math.round((x.ratingSum / x.ratingN) * 100) / 100 : null
    })).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name, 'ar'));
    const sum = k => staff.reduce((a, x) => a + x[k], 0);
    res.json({
      ok: true, date, target,
      totals: { done: sum('done'), negative: sum('negative'), noAnswer: sum('noAnswer'), refused: sum('refused'), wrongNumber: sum('wrongNumber'),
        staff: staff.length, staffMet: staff.filter(x => x.met).length },
      staff
    });
  });

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
