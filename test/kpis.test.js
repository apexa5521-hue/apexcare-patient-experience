'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeKpis, netScore } = require('../server/kpis');

const D1 = { id: 'd1', name: 'د. سارة', specialty: 'أسنان', branch: 'بريدة' };
const D2 = { id: 'd2', name: 'د. خالد', specialty: 'جلدية', branch: 'عنيزة' };

let seq = 0;
const ex = (over) => ({
  id: `e${++seq}`, visit_at: '2026-03-10T07:00:00.000Z', doctor_id: 'd1', branch: 'بريدة', sentiment: 'إيجابية',
  category: null, severity: null, booking_rating: 5, reception_rating: 5, plan_explained: 'نعم', doctor_rating: 5, ...over
});

test('net experience score = (pos − neg) / total × 100', () => {
  assert.equal(netScore(6, 2, 10), 40);
  assert.equal(netScore(1, 3, 4), -50);
  assert.equal(netScore(0, 0, 0), null);

  const k = computeKpis({
    doctors: [D1, D2],
    experiences: [
      ex({ sentiment: 'إيجابية' }), ex({ sentiment: 'إيجابية' }), ex({ sentiment: 'إيجابية' }),
      ex({ sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'عالية' }), ex({ sentiment: 'محايدة' })
    ]
  });
  const d1 = k.doctors.find(d => d.id === 'd1');
  assert.equal(d1.total, 5);
  assert.equal(d1.net, 40);
  assert.equal(d1.posPct, 60);
  assert.equal(d1.negPct, 20);
  assert.equal(d1.highSeverity, 1);
  assert.equal(d1.smallSample, true);
  assert.equal(k.summary.posPct, 60);
  assert.equal(k.doctors.find(d => d.id === 'd2').total, 0, 'doctors without data are still listed');
  assert.equal(k.doctors[0].id, 'd1', 'sorted by net score, empty last');
});

test('rating averages, per branch and per doctor', () => {
  const k = computeKpis({
    doctors: [D1, D2],
    experiences: [
      ex({ booking_rating: 5, reception_rating: 3, doctor_rating: 4 }),
      ex({ booking_rating: 4, reception_rating: 2, doctor_rating: 5 }),
      ex({ doctor_id: 'd2', branch: 'عنيزة', booking_rating: 1, reception_rating: 1, doctor_rating: 2 })
    ]
  });
  assert.equal(k.summary.avgBooking, 3.33);
  assert.equal(k.summary.avgReception, 2);
  assert.equal(k.summary.avgDoctor, 3.67);
  const b = Object.fromEntries(k.branches.map(x => [x.branch, x]));
  assert.equal(b['بريدة'].avgBooking, 4.5);
  assert.equal(b['بريدة'].avgReception, 2.5);
  assert.equal(b['عنيزة'].avgDoctor, 2);
  assert.equal(k.doctors.find(d => d.id === 'd1').avgDoctor, 4.5);
  assert.deepEqual(k.ratingDistribution.doctor, [0, 1, 0, 1, 1]);
  assert.deepEqual(k.ratingDistribution.booking, [1, 0, 0, 1, 1]);
});

test('plan clarity % excludes "لا ينطبق"', () => {
  const k = computeKpis({
    doctors: [D1],
    experiences: [
      ex({ plan_explained: 'نعم' }), ex({ plan_explained: 'نعم' }), ex({ plan_explained: 'لا' }),
      ex({ plan_explained: 'جزئياً' }), ex({ plan_explained: 'لا ينطبق', visit_type: 'كشف' }), ex({ plan_explained: 'لا ينطبق' })
    ]
  });
  assert.equal(k.summary.planYesPct, 50);
  assert.equal(k.doctors[0].planYesPct, 50);
  assert.equal(k.branches[0].planYesPct, 50);
});

test('time buckets use Riyadh wall-clock time', () => {
  // 23:30 Riyadh on Tuesday 2026-03-31 = 20:30 UTC. Must stay on the 31st, a Tuesday, March.
  const k = computeKpis({
    doctors: [D1],
    experiences: [ex({ visit_at: '2026-03-31T20:30:00.000Z', sentiment: 'سلبية', category: 'تأخر الموعد', doctor_rating: 2 })]
  });
  assert.equal(k.byHour[23].total, 1);
  assert.equal(k.byHour[23].neg, 1);
  assert.equal(k.byHour[23].avgDoctor, 2);
  assert.equal(k.byHour[20].total, 0);
  assert.equal(k.byWeekday[2].total, 1, 'Tuesday');
  assert.deepEqual(k.byMonth.map(m => m.key), ['2026-03']);
  assert.deepEqual(k.byYear.map(y => y.key), ['2026']);
  assert.equal(k.heatmap[2][23], 1);
  assert.equal(k.heatmap.flat().reduce((a, b) => a + b), 1);

  // New Year's Eve 23:30 Riyadh stays in the old year.
  const y = computeKpis({ doctors: [D1], experiences: [ex({ visit_at: '2025-12-31T20:30:00.000Z' })] });
  assert.deepEqual(y.byYear.map(p => p.key), ['2025']);
  assert.deepEqual(y.ratingTrend.map(p => p.key), ['2025-12']);
});

test('complaints: open, overdue, close time and top problems', () => {
  const now = new Date('2026-03-20T12:00:00Z');
  const k = computeKpis({
    now, overdueDays: 3,
    doctors: [D1],
    experiences: [
      ex({ sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'بسيطة' }),
      ex({ sentiment: 'سلبية', category: 'وقت الانتظار', severity: 'بسيطة' }),
      ex({ sentiment: 'سلبية', category: 'النظافة والتعقيم', severity: 'متوسطة' })
    ],
    complaints: [
      { id: 'c1', created_at: '2026-03-10T08:00:00Z', closed_at: '2026-03-10T20:00:00Z', status: 'مغلقة', doctor_id: 'd1', category: 'التكلفة والأسعار' },
      { id: 'c2', created_at: '2026-03-12T08:00:00Z', closed_at: null, status: 'جديدة', doctor_id: null, category: 'التكلفة والأسعار' },
      { id: 'c3', created_at: '2026-03-19T08:00:00Z', closed_at: null, status: 'قيد المعالجة', doctor_id: 'd1', category: null },
      { id: 'c4', created_at: '2026-03-01T08:00:00Z', closed_at: '2026-03-02T08:00:00Z', status: 'مغلقة', doctor_id: null, category: null }
    ]
  });
  assert.equal(k.summary.complaints, 4);
  assert.equal(k.summary.openComplaints, 2);
  assert.equal(k.summary.overdueComplaints, 1);
  assert.equal(k.summary.avgCloseHours, 18);
  assert.equal(k.doctors[0].complaints, 2);
  assert.equal(k.doctors[0].avgCloseHours, 12);
  assert.deepEqual(k.topProblems.experiences, [{ name: 'وقت الانتظار', count: 2 }, { name: 'النظافة والتعقيم', count: 1 }]);
  assert.deepEqual(k.topProblems.complaints, [{ name: 'التكلفة والأسعار', count: 2 }]);
});

test('empty input gives nulls, not NaN', () => {
  const k = computeKpis({});
  assert.equal(k.summary.total, 0);
  assert.equal(k.summary.posPct, null);
  assert.equal(k.summary.avgDoctor, null);
  assert.equal(k.summary.avgCloseHours, null);
  assert.equal(JSON.stringify(k).includes('NaN'), false);
});
