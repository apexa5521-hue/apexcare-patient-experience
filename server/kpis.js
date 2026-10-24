'use strict';

// KPI aggregation. Pure functions over already-filtered rows (DB column names),
// bucketed by wall-clock time in `tz`.

const { localParts } = require('./time');
const { NOT_APPLICABLE } = require('./validate');

const SMALL_SAMPLE = 20;
const RATING_KEYS = { booking: 'booking_rating', reception: 'reception_rating', doctor: 'doctor_rating' };

const round = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const pct = (a, b) => (b ? round((a / b) * 100, 1) : null);

/** Running mean that ignores null/undefined values. */
class Mean {
  constructor() { this.sum = 0; this.n = 0; }
  add(v) { if (v !== null && v !== undefined && v !== '') { this.sum += Number(v); this.n++; } }
  get value() { return this.n ? round(this.sum / this.n, 2) : null; }
}

/** Share of "نعم" among plan answers, excluding "لا ينطبق" and blanks. */
class PlanRate {
  constructor() { this.yes = 0; this.n = 0; }
  add(v) { if (!v || v === NOT_APPLICABLE) return; this.n++; if (v === 'نعم') this.yes++; }
  get value() { return pct(this.yes, this.n); }
}

function sentimentKey(s) {
  return s === 'إيجابية' ? 'pos' : s === 'سلبية' ? 'neg' : 'neu';
}

/** (positive − negative) ÷ total × 100, rounded; null for no data. */
function netScore(pos, neg, total) {
  return total ? Math.round(((pos - neg) / total) * 100) : null;
}

function closeHours(c) {
  if (c.status !== 'مغلقة' || !c.closed_at) return null;
  const h = (new Date(c.closed_at) - new Date(c.created_at)) / 3600000;
  return h >= 0 ? h : null;
}

function isOverdue(c, now, overdueDays) {
  return c.status !== 'مغلقة' && now - new Date(c.created_at) > overdueDays * 86400000;
}

function timePoint() {
  return { total: 0, neg: 0, doctor: new Mean() };
}
function finishPoint(p, extra) {
  return { ...extra, total: p.total, neg: p.neg, avgDoctor: p.doctor.value };
}

function topN(counts, n = 10) {
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')).slice(0, n);
}

function computeKpis({ experiences = [], complaints = [], doctors = [], tz = 'Asia/Riyadh', overdueDays = 3, now = new Date() }) {
  const sent = { pos: 0, neg: 0, neu: 0 };
  const means = { booking: new Mean(), reception: new Mean(), doctor: new Mean() };
  const plan = new PlanRate();
  const dist = { booking: [0, 0, 0, 0, 0], reception: [0, 0, 0, 0, 0], doctor: [0, 0, 0, 0, 0] };

  const docs = new Map();
  const docEntry = (id) => {
    if (!docs.has(id)) {
      docs.set(id, { total: 0, pos: 0, neg: 0, neu: 0, high: 0, doctor: new Mean(), plan: new PlanRate(), complaints: 0, close: new Mean() });
    }
    return docs.get(id);
  };
  for (const d of doctors) docEntry(d.id);

  const branches = new Map();
  const branchEntry = (b) => {
    if (!branches.has(b)) branches.set(b, { total: 0, booking: new Mean(), reception: new Mean(), doctor: new Mean(), plan: new PlanRate() });
    return branches.get(b);
  };

  const exCats = new Map();
  const channels = new Map();
  const hours = Array.from({ length: 24 }, timePoint);
  const weekdays = Array.from({ length: 7 }, timePoint);
  const months = new Map();
  const years = new Map();
  const trend = new Map();
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const e of experiences) {
    const k = sentimentKey(e.sentiment);
    const chName = e.channel || 'حضوري';
    if (!channels.has(chName)) channels.set(chName, { total: 0, neg: 0, booking: new Mean(), reception: new Mean(), doctor: new Mean(), plan: new PlanRate() });
    const ch = channels.get(chName);
    ch.total++; if (k === 'neg') ch.neg++;
    ch.booking.add(e.booking_rating); ch.reception.add(e.reception_rating); ch.doctor.add(e.doctor_rating); ch.plan.add(e.plan_explained);
    sent[k]++;
    for (const [name, col] of Object.entries(RATING_KEYS)) {
      means[name].add(e[col]);
      const v = Number(e[col]);
      if (v >= 1 && v <= 5) dist[name][v - 1]++;
    }
    plan.add(e.plan_explained);

    const d = docEntry(e.doctor_id);
    d.total++; d[k]++;
    if (k === 'neg' && e.severity === 'عالية') d.high++;
    d.doctor.add(e.doctor_rating);
    d.plan.add(e.plan_explained);

    const b = branchEntry(e.branch);
    b.total++;
    b.booking.add(e.booking_rating); b.reception.add(e.reception_rating); b.doctor.add(e.doctor_rating);
    b.plan.add(e.plan_explained);

    if (k === 'neg' && e.category) exCats.set(e.category, (exCats.get(e.category) || 0) + 1);

    const t = localParts(e.visit_at, tz);
    const isNeg = k === 'neg' ? 1 : 0;
    const monthKey = t.date.slice(0, 7);
    const yearKey = t.date.slice(0, 4);
    if (!months.has(monthKey)) months.set(monthKey, timePoint());
    if (!years.has(yearKey)) years.set(yearKey, timePoint());
    if (!trend.has(monthKey)) trend.set(monthKey, { booking: new Mean(), reception: new Mean(), doctor: new Mean() });
    for (const p of [hours[t.hour], weekdays[t.weekday], months.get(monthKey), years.get(yearKey)]) {
      p.total++; p.neg += isNeg; p.doctor.add(e.doctor_rating);
    }
    const tr = trend.get(monthKey);
    tr.booking.add(e.booking_rating); tr.reception.add(e.reception_rating); tr.doctor.add(e.doctor_rating);
    if (isNeg) heat[t.weekday][t.hour]++;
  }

  const coCats = new Map();
  const close = new Mean();
  let open = 0, overdue = 0;
  for (const c of complaints) {
    if (c.status !== 'مغلقة') open++;
    if (isOverdue(c, now, overdueDays)) overdue++;
    const h = closeHours(c);
    close.add(h);
    if (c.doctor_id) {
      const d = docEntry(c.doctor_id);
      d.complaints++;
      d.close.add(h);
    }
    if (c.category) coCats.set(c.category, (coCats.get(c.category) || 0) + 1);
  }

  const total = experiences.length;
  const docInfo = new Map(doctors.map(d => [d.id, d]));
  const doctorRows = [...docs.entries()].map(([id, d]) => {
    const info = docInfo.get(id) || {};
    return {
      id, name: info.name || '—', specialty: info.specialty || '', branch: info.branch || '',
      total: d.total, pos: d.pos, neu: d.neu, neg: d.neg,
      posPct: pct(d.pos, d.total), neuPct: pct(d.neu, d.total), negPct: pct(d.neg, d.total),
      net: netScore(d.pos, d.neg, d.total),
      avgDoctor: d.doctor.value, planYesPct: d.plan.value,
      highSeverity: d.high, complaints: d.complaints,
      avgCloseHours: d.close.value === null ? null : round(d.close.value, 1),
      smallSample: d.total < SMALL_SAMPLE
    };
  }).sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity) || b.total - a.total);

  const branchRows = [...branches.entries()].map(([branch, b]) => ({
    branch, total: b.total,
    avgBooking: b.booking.value, avgReception: b.reception.value, avgDoctor: b.doctor.value, planYesPct: b.plan.value
  })).sort((a, b) => a.branch.localeCompare(b.branch, 'ar'));

  const sortedSeries = (m) => [...m.keys()].sort().map(key => finishPoint(m.get(key), { key }));

  return {
    summary: {
      total, pos: sent.pos, neg: sent.neg, neu: sent.neu,
      posPct: pct(sent.pos, total), negPct: pct(sent.neg, total), neuPct: pct(sent.neu, total),
      avgBooking: means.booking.value, avgReception: means.reception.value, avgDoctor: means.doctor.value,
      planYesPct: plan.value,
      complaints: complaints.length, openComplaints: open, overdueComplaints: overdue,
      avgCloseHours: close.value === null ? null : round(close.value, 1)
    },
    doctors: doctorRows,
    branches: branchRows,
    ratingDistribution: dist,
    topProblems: { experiences: topN(exCats), complaints: topN(coCats) },
    byHour: hours.map((p, hour) => finishPoint(p, { hour })),
    byWeekday: weekdays.map((p, weekday) => finishPoint(p, { weekday })),
    byMonth: sortedSeries(months),
    byYear: sortedSeries(years),
    heatmap: heat,
    byChannel: ['حضوري', 'اتصال'].filter(c => channels.has(c)).map(channel => {
      const c = channels.get(channel);
      return { channel, total: c.total, sharePct: pct(c.total, total), negPct: pct(c.neg, c.total),
        avgBooking: c.booking.value, avgReception: c.reception.value, avgDoctor: c.doctor.value, planYesPct: c.plan.value };
    }),
    ratingTrend: [...trend.keys()].sort().map(key => {
      const t = trend.get(key);
      return { key, booking: t.booking.value, reception: t.reception.value, doctor: t.doctor.value };
    })
  };
}

module.exports = { computeKpis, netScore, isOverdue, SMALL_SAMPLE };
