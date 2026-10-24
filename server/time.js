'use strict';

// Timezone helpers. Every date/time the user sees or filters on is wall-clock time in TZ_NAME.

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    }));
  }
  return fmtCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local wall-clock parts of an instant in tz. */
function localParts(input, tz) {
  const d = input instanceof Date ? input : new Date(input);
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(d)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`
  };
}

/** Offset (ms) of tz from UTC at the given instant. */
function offsetMs(instant, tz) {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Convert local "YYYY-MM-DD" + "HH:mm" in tz to a UTC Date. */
function localToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  // Two passes handle DST edges; Riyadh has none, but TZ_NAME is configurable.
  let t = new Date(guess.getTime() - offsetMs(guess, tz));
  t = new Date(guess.getTime() - offsetMs(t, tz));
  return t;
}

/** "YYYY-MM-DD" + n days. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm" in tz, or '' for empty input. */
function formatLocal(input, tz) {
  if (!input) return '';
  const p = localParts(input, tz);
  return `${p.date} ${p.time}`;
}

module.exports = { localParts, localToUtc, addDays, formatLocal };
