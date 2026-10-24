'use strict';

// Service-rating QR survey: turns the form's text answers into 1–5 scores and decides
// whether a response needs follow-up. Answers arrive as the form wrote them
// ("Strongly agree  أوافق بشدة", "Probably yes ربما نعم", "Excellent ممتاز"…), with
// inconsistent spacing, so matching is by keyword, most specific first.

const QUESTIONS = [
  { key: 'q_booking', label: 'سهولة حجز الموعد', scale: 'agree' },
  { key: 'q_reception', label: 'حفاوة الاستقبال', scale: 'agree' },
  { key: 'q_waiting', label: 'وقت الانتظار', scale: 'agree' },
  { key: 'q_explanation', label: 'شرح الطبيب للتشخيص والعلاج', scale: 'agree' },
  { key: 'q_care', label: 'الرضا عن الرعاية', scale: 'agree' },
  { key: 'q_recommend', label: 'التوصية بالمركز', scale: 'recommend' },
  { key: 'q_overall', label: 'الرضا العام', scale: 'overall' }
];

const SCALES = {
  agree: [
    [/strongly\s*disagree|ارفض\s*بشده|لا\s*اوافق\s*بشده/, 1],
    [/strongly\s*agree|اوافق\s*بشده/, 5],
    [/disagree|ارفض|لا\s*اوافق|لا\s*يوافق/, 2],
    [/neutral|حيادي|محايد/, 3],
    [/agree|يوافق|اوافق/, 4]
  ],
  recommend: [
    [/definitely\s*not|بالتاكيد\s*لا/, 1],
    [/probably\s*not|ربما\s*لا/, 2],
    [/not\s*sure|unsure|غير\s*متاكد|لا\s*اعرف/, 3],
    [/definitely\s*yes|بالتاكيد\s*نعم/, 5],
    [/probably\s*yes|ربما\s*نعم/, 4]
  ],
  // Works for 3-point (Excellent/Good/Poor) and 5-point (…/Very good/…/Fair/…) versions.
  overall: [
    [/very\s*poor|سيء\s*جدا|ضعيف\s*جدا/, 1],
    [/very\s*good|جيد\s*جدا/, 4],
    [/excellent|ممتاز/, 5],
    [/fair|مقبول|متوسط/, 2],
    [/poor|فقير|ضعيف|سيء/, 1],
    [/good|جيد/, 3]
  ]
};

function norm(v) {
  return String(v ?? '').toLowerCase()
    .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}

/** 1–5, or null for blank/unrecognised answers. Numeric answers 1–5 pass through. */
function score(answer, scale) {
  const s = norm(answer);
  if (!s) return null;
  if (/^[1-5]$/.test(s)) return Number(s);
  for (const [re, n] of SCALES[scale]) if (re.test(s)) return n;
  return null;
}

/**
 * Whether a response needs a follow-up case, and how urgent.
 * High: overall or care satisfaction at the bottom. Medium: any answer at 2 or below.
 */
function assess(scores) {
  const low = QUESTIONS.filter(q => scores[q.key] !== null && scores[q.key] !== undefined && scores[q.key] <= 2);
  if (!low.length) return null;
  const severity = scores.q_overall === 1 || scores.q_care === 1 ? 'عالية' : 'متوسطة';
  return { severity, summary: `تقييم خدمة منخفض في: ${low.map(q => q.label).join('، ')}`, lowKeys: low.map(q => q.key) };
}

module.exports = { QUESTIONS, score, assess, norm };
