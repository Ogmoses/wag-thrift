'use strict';
// ─── Verification harness for the WAG cumulative-logbook slot math ───
// Run with: node test-logic.js
// Everything in this file is copied verbatim into the two production
// files (generate-report.js and worker.js) once it passes here.

const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1, fixed (no DST in Nigeria)

function toWATParts(date) {
  const w = new Date(date.getTime() + WAT_OFFSET_MS);
  return {
    year: w.getUTCFullYear(),
    month0: w.getUTCMonth(),
    day: w.getUTCDate(),
    weekday: w.getUTCDay(), // 0=Sun..6=Sat
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function watDateKey(date) {
  const { year, month0, day } = toWATParts(date);
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

function watYearMonth(date) {
  const { year, month0 } = toWATParts(date);
  return `${year}-${pad2(month0 + 1)}`;
}

// The instant that is Y-M0-D 00:00:00 WAT, expressed as a UTC Date.
function watMidnightUTC(year, month0, day) {
  return new Date(Date.UTC(year, month0, day, 0, 0, 0) - WAT_OFFSET_MS);
}

// The last instant (23:59:59.999) of Y-M0 in WAT, expressed as a UTC Date.
function watMonthEndUTC(year, month0) {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month0, lastDay, 23, 59, 59, 999) - WAT_OFFSET_MS);
}

function calendarWeekday(year, month0, day) {
  return new Date(Date.UTC(year, month0, day)).getUTCDay();
}

function isBusinessDay(year, month0, day) {
  const wd = calendarWeekday(year, month0, day);
  return wd >= 1 && wd <= 5;
}

// Business days (Mon-Fri) in Y-M0, from day 1 up to and including uptoDay
// (or the whole month if uptoDay is omitted). Returns {year,month0,day,dateUTC}.
function businessDaysInMonth(year, month0, uptoDay) {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const limit = uptoDay ? Math.min(uptoDay, lastDay) : lastDay;
  const out = [];
  for (let d = 1; d <= limit; d++) {
    if (isBusinessDay(year, month0, d)) {
      out.push({ year, month0, day: d, dateUTC: watMidnightUTC(year, month0, d) });
    }
  }
  return out;
}

function prevYearMonth(year, month0) {
  return month0 === 0 ? { year: year - 1, month0: 11 } : { year, month0: month0 - 1 };
}

// Converts a decimal slot count into traditional fraction notation.
// A "slot" = one day's Rate; the only fraction this business uses in
// practice is a half (a ₦500-on-₦1,000-rate deposit), so that's the only
// case rendered as a glyph. Anything else is shown as a plain decimal
// rather than silently misrepresented as the nearest half/whole.
function formatSlotFraction(decimalValue) {
  const n = Number(decimalValue) || 0;
  if (n <= 1e-9) return '0';
  const whole = Math.trunc(n + 1e-9);
  const frac = n - whole;
  const EPS = 1e-6;
  if (frac < EPS) return String(whole);
  if (Math.abs(frac - 0.5) < EPS) return whole === 0 ? '½' : `${whole} ½`;
  // Not a clean half — round to 2dp and trim trailing zeros rather than
  // force it into a fraction glyph that would misstate the real amount.
  return (Math.round(n * 100) / 100).toString();
}

// ─── TESTS ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}

console.log('--- formatSlotFraction ---');
eq('0 deposit', formatSlotFraction(0), '0');
eq('half slot', formatSlotFraction(0.5), '½');
eq('one slot', formatSlotFraction(1), '1');
eq('one and half', formatSlotFraction(1.5), '1 ½');
eq('two slots', formatSlotFraction(2), '2');
eq('two and half', formatSlotFraction(2.5), '2 ½');
eq('zero from float noise', formatSlotFraction(1e-12), '0');
eq('odd decimal (333/1000)', formatSlotFraction(333 / 1000), '0.33');
eq('large cumulative', formatSlotFraction(47.5), '47 ½');
eq('float rounding near whole', formatSlotFraction(2.9999999999), '3');
eq('float rounding near half', formatSlotFraction(2.500000001), '2 ½');
eq('quarter (not a supported glyph)', formatSlotFraction(0.25), '0.25');

console.log('--- WAT date bucketing ---');
// 23:30 UTC on Aug 14 2026 = 00:30 WAT on Aug 15 2026 (UTC+1 rolls the date forward)
eq('late-UTC rolls to next WAT day', watDateKey(new Date('2026-08-14T23:30:00Z')), '2026-08-15');
// 22:30 UTC on Aug 14 2026 = 23:30 WAT, still Aug 14
eq('22:30 UTC stays same WAT day', watDateKey(new Date('2026-08-14T22:30:00Z')), '2026-08-14');
eq('yearMonth extraction', watYearMonth(new Date('2026-08-14T23:30:00Z')), '2026-08');

console.log('--- business day enumeration ---');
// August 2026: Aug 1 = Saturday. So weekdays start Aug 3 (Mon).
eq('Aug 1 2026 is a Saturday', calendarWeekday(2026, 7, 1), 6);
const augDaysTo14 = businessDaysInMonth(2026, 7, 14).map(d => d.day);
eq('business days Aug 1-14 2026', augDaysTo14, [3, 4, 5, 6, 7, 10, 11, 12, 13, 14]);
eq('count = 10 weekdays', augDaysTo14.length, 10);

console.log('--- month rollover ---');
eq('Jan rolls to prior Dec', prevYearMonth(2026, 0), { year: 2025, month0: 11 });
eq('normal month back', prevYearMonth(2026, 7), { year: 2026, month0: 6 });

console.log('--- month-end UTC instant sanity ---');
// End of August 2026 in WAT = Aug 31 23:59:59.999 WAT = Aug 31 22:59:59.999 UTC
const endAug = watMonthEndUTC(2026, 7);
eq('month-end UTC instant', endAug.toISOString(), '2026-08-31T22:59:59.999Z');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
