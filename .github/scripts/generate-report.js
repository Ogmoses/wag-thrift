/**
 * WAG Enterprises — Cumulative Daily Logbook
 *
 * Generates the daily field-logbook report and emails it to the admin(s)
 * via Resend as a PDF. Sent Monday through Friday at 9:00 PM WAT.
 *
 * Layout: one block per active customer plan, and inside each block, one
 * ROW PER BUSINESS DAY of the current month so far — a running passbook,
 * not a single snapshot:
 *
 *   Bola Tunde — Shop rent          Rate: NGN 1,500     Previous: 0
 *   ┌────────────┬────────────┬─────────┐
 *   │ DATE       │ AMOUNT     │ NO.     │
 *   ├────────────┼────────────┼─────────┤
 *   │ Mon 3      │ NGN 0      │ 0       │
 *   │ Tue 4      │ NGN 0      │ 0       │
 *   │ Wed 5      │ NGN 7,500  │ 5       │
 *   │ Thu 6      │ NGN 1,500  │ 6       │
 *   │ Fri 7      │ NGN 3,000  │ 8       │
 *   │ ...        │ ...        │ ...     │
 *   └────────────┴────────────┴─────────┘
 *
 * No. on each day = No. from the day before + that day's payment ÷ Rate.
 * The very first day of the month starts from Previous (last month's
 * closing No.), which is why Previous is shown once, above the table,
 * not repeated on every row — it's the fixed starting point the first
 * row's No. is computed from, not itself a day.
 *
 * This grows a little longer every day the report runs (one more row per
 * customer) and resets back to a single starting row — with Previous
 * carried forward from last month's close — the first business day of a
 * new month. That's the whole point: it's the same accumulation a field
 * agent's paper logbook page does over the course of a month.
 *
 * This REPLACES two earlier cuts of this report (a landscape grid with
 * one COLUMN per business day, and later a flat one-row-per-customer
 * snapshot) — see MIGRATION NOTES.md for history. Still separate from
 * the raw SQL backup (db-backup.yml), which is for disaster recovery,
 * not day-to-day reading.
 *
 * Usage: node generate-report.js
 *
 * Required environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
 *   RESEND_FROM_EMAIL, ADMIN_EMAILS (comma-separated, fallback only)
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  ADMIN_EMAILS,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
  console.error('Missing required environment variables. Check repo secrets.');
  process.exit(1);
}

const NOW = new Date();

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// ─── SUPABASE HELPERS ─────────────────────────────────────────────────────

async function fetchRows(table, params) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`Failed to fetch ${table}:`, await res.text());
    return [];
  }
  return res.json();
}

// Idempotent insert — ignores a duplicate-key conflict (the UNIQUE
// (plan_id, year_month) constraint) instead of erroring, so a
// double-run or a race with the manual "Send Report Now" button can
// never crash or double-write a closing balance.
async function insertIgnoreDuplicate(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) console.error(`Failed to insert into ${table}:`, await res.text());
}

async function insertAuditLog(row) {
  await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

// ─── WAT (West Africa Time, UTC+1, no DST) DATE HELPERS ───────────────────
// Nigeria does not observe daylight saving, so this is a fixed +1h offset
// — no timezone database / Intl dependency needed. Verified against a
// standalone test suite (test-logic.js) before being placed here.

const WAT_OFFSET_MS = 60 * 60 * 1000;
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toWATParts(date) {
  const w = new Date(date.getTime() + WAT_OFFSET_MS);
  return { year: w.getUTCFullYear(), month0: w.getUTCMonth(), day: w.getUTCDate(), weekday: w.getUTCDay() };
}
function pad2(n) { return String(n).padStart(2, '0'); }
function watDateKey(date) { const { year, month0, day } = toWATParts(date); return `${year}-${pad2(month0 + 1)}-${pad2(day)}`; }
function yearMonthKeyOf({ year, month0 }) { return `${year}-${pad2(month0 + 1)}`; }
function watMidnightUTC(year, month0, day) { return new Date(Date.UTC(year, month0, day, 0, 0, 0) - WAT_OFFSET_MS); }
function watMonthEndUTC(year, month0) {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month0, lastDay, 23, 59, 59, 999) - WAT_OFFSET_MS);
}
function calendarWeekday(year, month0, day) { return new Date(Date.UTC(year, month0, day)).getUTCDay(); }
function isBusinessDay(year, month0, day) { const wd = calendarWeekday(year, month0, day); return wd >= 1 && wd <= 5; }

// Business days (Mon-Fri) in year/month0, from day 1 up to and including
// uptoDay. If uptoDay itself isn't a business day (e.g. a manual send on
// a Saturday), the list simply stops at the most recent one.
function businessDaysInMonth(year, month0, uptoDay) {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const limit = Math.min(uptoDay, lastDay);
  const out = [];
  for (let d = 1; d <= limit; d++) if (isBusinessDay(year, month0, d)) out.push({ year, month0, day: d });
  return out;
}
function prevYearMonth(year, month0) { return month0 === 0 ? { year: year - 1, month0: 11 } : { year, month0: month0 - 1 }; }
function dayKeyOf({ year, month0, day }) { return `${year}-${pad2(month0 + 1)}-${pad2(day)}`; }
function dayLabelOf({ year, month0, day }) { return `${WEEKDAY_ABBR[calendarWeekday(year, month0, day)]} ${day}`; }

// Converts a decimal slot count into traditional fraction notation, per
// the field-logbook convention: a "slot" is one full day's Rate, and the
// only fraction this business uses in practice is a half (e.g. a ₦500
// payment against a ₦1,000 rate). Anything that isn't a clean whole or
// half is shown as a plain decimal rather than silently forced into the
// nearest fraction glyph and misstating the real amount paid.
function formatSlotFraction(decimalValue) {
  const n = Number(decimalValue) || 0;
  if (n <= 1e-9) return '0';
  const whole = Math.trunc(n + 1e-9);
  const frac = n - whole;
  const EPS = 1e-6;
  if (frac < EPS) return String(whole);
  if (Math.abs(frac - 0.5) < EPS) return whole === 0 ? '½' : `${whole} ½`;
  return (Math.round(n * 100) / 100).toString();
}

function fmtNaira(n) { return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
// pdf-lib's built-in Helvetica can't encode ₦ (outside WinAnsi) — PDFs use
// "NGN" instead. The HTML email keeps the real ₦ symbol.
function fmtNairaPDF(n) { return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function pdfSafe(str) {
  return String(str ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/₦/g, 'NGN ').replace(/[^\x00-\xFF]/g, '?');
}

// ─── GATHER: active plans, day-by-day amounts, running cumulative ────────

async function gatherLedgerData() {
  const { year: Y, month0: M0, day: D } = toWATParts(NOW);
  const YEAR_MONTH = yearMonthKeyOf({ year: Y, month0: M0 });
  const { year: PY, month0: PM0 } = prevYearMonth(Y, M0);
  const PREV_YEAR_MONTH = yearMonthKeyOf({ year: PY, month0: PM0 });

  const [activeCustomers, activePlans] = await Promise.all([
    fetchRows('customers', 'status=eq.active&select=id,first_name,last_name'),
    fetchRows('plans', 'status=eq.active&select=id,customer_id,name,regular_contribution,created_at&order=created_at.asc'),
  ]);
  const custMap = {};
  activeCustomers.forEach(c => { custMap[c.id] = c; });
  // Only plans belonging to an active customer — a suspended customer's
  // plan isn't being actively collected against, so it doesn't belong in
  // today's field logbook. "till the person finally withdraws and stops
  // the plan" — once a plan is closed/deleted it drops off here too,
  // since it's no longer status=active.
  const plans = activePlans.filter(p => custMap[p.customer_id]);

  const dayList = businessDaysInMonth(Y, M0, D);
  const dayKeys = dayList.map(dayKeyOf);
  const dayKeySet = new Set(dayKeys);
  // Assigns a transaction to the nearest visible business-day row on or
  // after its real WAT date (rolls a weekend transaction forward to the
  // next business day; clamps to the last row if "today" itself is a
  // weekend). Guarantees, by construction, that a plan's day-by-day
  // Amount column always sums to exactly its final No. — no money is
  // ever silently missing from the printed trail.
  function assignToVisibleDay(txDateKey) {
    if (!dayKeys.length) return null;
    if (dayKeySet.has(txDateKey)) return txDateKey;
    for (const k of dayKeys) if (k >= txDateKey) return k;
    return dayKeys[dayKeys.length - 1];
  }

  if (!plans.length) {
    return { Y, M0, D, YEAR_MONTH, dayList, rows: [], grandTodayNaira: 0 };
  }

  // ── Ensure every plan's PREVIOUS month is closed out before we read
  // its carryover. Self-healing: if this is the very first run (no
  // monthly_ledgers rows exist at all) or the report didn't run for a
  // while, it walks back to the most recent CLOSED month on file (or
  // the beginning of the plan's history if none) and sums every
  // confirmed opening/deposit transaction in the gap — so the baseline
  // is always correct off the immutable transaction log, never assumed.
  await Promise.all(plans.map(async (plan) => {
    const already = await fetchRows('monthly_ledgers', `plan_id=eq.${plan.id}&year_month=eq.${PREV_YEAR_MONTH}&select=id&limit=1`);
    if (already.length) return;

    const priorClosed = await fetchRows(
      'monthly_ledgers',
      `plan_id=eq.${plan.id}&year_month=lt.${PREV_YEAR_MONTH}&select=year_month,closing_slots&order=year_month.desc&limit=1`
    );
    let baseSlots = 0;
    let sinceISO = new Date(0).toISOString();
    if (priorClosed.length) {
      baseSlots = Number(priorClosed[0].closing_slots);
      const [py, pm] = priorClosed[0].year_month.split('-').map(Number);
      sinceISO = watMonthEndUTC(py, pm - 1).toISOString();
    }
    const untilISO = watMonthEndUTC(PY, PM0).toISOString();
    const gapTx = await fetchRows(
      'transactions',
      `plan_id=eq.${plan.id}&status=eq.confirmed&type=in.(opening,deposit)&created_at=gt.${sinceISO}&created_at=lte.${untilISO}&select=amount`
    );
    const gapAmount = gapTx.reduce((s, t) => s + Number(t.amount), 0);
    const closingSlots = baseSlots + gapAmount / Number(plan.regular_contribution);
    await insertIgnoreDuplicate('monthly_ledgers', {
      plan_id: plan.id, customer_id: plan.customer_id, year_month: PREV_YEAR_MONTH, closing_slots: closingSlots,
    });
  }));

  const previousRows = await fetchRows(
    'monthly_ledgers',
    `plan_id=in.(${plans.map(p => p.id).join(',')})&year_month=eq.${PREV_YEAR_MONTH}&select=plan_id,closing_slots`
  );
  const previousByPlan = {};
  previousRows.forEach(r => { previousByPlan[r.plan_id] = Number(r.closing_slots); });

  // ── This month's confirmed deposits for every active plan, bucketed
  // by business-day row.
  const monthStartISO = watMidnightUTC(Y, M0, 1).toISOString();
  const monthTx = await fetchRows(
    'transactions',
    `plan_id=in.(${plans.map(p => p.id).join(',')})&status=eq.confirmed&type=in.(opening,deposit)&created_at=gte.${monthStartISO}&created_at=lte.${NOW.toISOString()}&select=plan_id,amount,created_at&order=created_at.asc`
  );
  const bucket = {}; // planId -> dayKey -> naira amount
  monthTx.forEach(t => {
    const col = assignToVisibleDay(watDateKey(new Date(t.created_at)));
    if (!col) return;
    bucket[t.plan_id] = bucket[t.plan_id] || {};
    bucket[t.plan_id][col] = (bucket[t.plan_id][col] || 0) + Number(t.amount);
  });

  let grandTodayNaira = 0;
  const todayKey = dayKeys[dayKeys.length - 1] || null;

  const rows = plans.map(plan => {
    const cust = custMap[plan.customer_id];
    const rate = Number(plan.regular_contribution);
    const previousSlots = previousByPlan[plan.id] || 0;
    const planBucket = bucket[plan.id] || {};

    // The running cumulative — each day starts from wherever the day
    // before left off, and the very first day of the month starts from
    // Previous. This loop IS "yesterday's No. + today's slots".
    let running = previousSlots;
    const days = dayList.map((dd, i) => {
      const key = dayKeys[i];
      const amount = planBucket[key] || 0;
      running += amount / rate;
      return { dateLabel: dayLabelOf(dd), amount, noFraction: formatSlotFraction(running) };
    });

    if (todayKey) grandTodayNaira += planBucket[todayKey] || 0;

    return {
      customerName: `${cust.first_name} ${cust.last_name}`,
      planName: plan.name,
      rate,
      previousFraction: formatSlotFraction(previousSlots),
      days,
    };
  }).sort((a, b) => a.customerName.localeCompare(b.customerName) || a.planName.localeCompare(b.planName));

  return { Y, M0, D, YEAR_MONTH, dayList, rows, grandTodayNaira };
}

// ─── BUILD HTML EMAIL ──────────────────────────────────────────────────────
// The email body is a condensed today-only summary for a quick glance —
// the full day-by-day passbook (the part that grows through the month)
// is in the attached PDF, which is what's meant to be printed and filed.

function buildHTML(d) {
  const dateLabel = new Date(Date.UTC(d.Y, d.M0, d.D)).toLocaleDateString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const businessDayNum = d.dayList.length;

  const rowsHTML = d.rows.length
    ? d.rows.map(r => {
        const todayRow = r.days[r.days.length - 1] || { amount: 0, noFraction: r.previousFraction };
        return `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;color:#111827;">
          <div style="font-weight:700;">${r.customerName}</div>
          <div style="font-size:10px;color:#9ca3af;">${r.planName}</div>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#374151;">${fmtNaira(r.rate)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#374151;">${fmtNaira(todayRow.amount)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:13px;font-weight:800;text-align:right;color:#011f7b;">${todayRow.noFraction}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#9ca3af;">${r.previousFraction}</td>
      </tr>`;
      }).join('')
    : `<tr><td colspan="5" style="padding:14px;text-align:center;color:#9ca3af;font-size:12px;">No active customer plans yet.</td></tr>`;

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#f4f6fb;padding:24px 16px;">
    <div style="background:#011f7b;border-radius:14px 14px 0 0;padding:24px 28px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="color:#FFBA09;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Wonderful &amp; Able God Enterprises</div>
        <div style="color:#8a97c2;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid #2a3a7a;border-radius:4px;padding:2px 7px;">Confidential</div>
      </div>
      <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px;">Daily Cumulative Logbook</div>
      <div style="color:#c7d2ea;font-size:13px;margin-top:4px;">${dateLabel} — Business day ${businessDayNum} of ${d.YEAR_MONTH}</div>
    </div>
    <div style="background:#fff;padding:24px 28px;">
      <div style="background:#f0f4ff;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">Deposited Today</div>
        <div style="font-size:22px;font-weight:800;color:#011f7b;">${fmtNaira(d.grandTodayNaira)}</div>
      </div>
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Today's Snapshot (${d.rows.length} active plan${d.rows.length === 1 ? '' : 's'})</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase;">Name</th>
            <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;">Rate</th>
            <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;">Amount</th>
            <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;">No.</th>
            <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;">Previous</th>
          </tr>
        </thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      <p style="color:#9ca3af;font-size:11px;margin-top:24px;text-align:center;">
        This is today's line only. The attached PDF has the full day-by-day passbook for ${d.YEAR_MONTH} —<br>
        every business day so far this month, with No. accumulating down the page from Previous.<br>
        This report covers deposit activity only. The full admin audit trail stays in-app under Admin → Settings → Audit Log.
      </p>
    </div>
  </div>`;
}

// ─── BUILD PDF (Portrait, one passbook block per customer) ───────────────

async function buildPDF(d) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.004, 0.122, 0.482);
  const GOLD = rgb(0.7, 0.5, 0);
  const GREY = rgb(0.42, 0.45, 0.5);
  const BLACK = rgb(0.07, 0.09, 0.14);
  const GREEN = rgb(0.08, 0.5, 0.18);
  const LIGHT_BG = rgb(0.96, 0.97, 1);
  const PAGE_W = 595, PAGE_H = 842, MARGIN = 40; // A4 portrait, points
  const gridW = PAGE_W - MARGIN * 2;

  const DATE_W = 180, AMOUNT_W = 180;
  const NO_W = gridW - DATE_W - AMOUNT_W;

  const BLOCK_HEADER_H = 30;
  const TABLE_HEADER_H = 16;
  const DAY_ROW_H = 15;
  const BLOCK_GAP = 12;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const dateLabel = new Date(Date.UTC(d.Y, d.M0, d.D)).toLocaleDateString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  function drawPageTop() {
    page.drawText('WONDERFUL & ABLE GOD ENTERPRISES', { x: MARGIN, y, size: 10, font: bold, color: GOLD });
    const conf = 'CONFIDENTIAL';
    page.drawText(conf, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(conf, 8), y, size: 8, font: bold, color: GREY });
    y -= 18;
    page.drawText(`Daily Cumulative Logbook - ${dateLabel}`, { x: MARGIN, y, size: 14, font: bold, color: NAVY });
    y -= 15;
    const sub = `Business day ${d.dayList.length} of ${d.YEAR_MONTH}   |   Deposited today: ${fmtNairaPDF(d.grandTodayNaira)}   |   Active plans: ${d.rows.length}`;
    page.drawText(sub, { x: MARGIN, y, size: 8.5, font, color: GREY });
    y -= 18;
  }

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
    drawPageTop();
  }

  drawPageTop();

  if (!d.rows.length) {
    page.drawText('No active customer plans yet.', { x: MARGIN + 6, y: y - 14, size: 9, font, color: GREY });
  }

  d.rows.forEach((r) => {
    const blockH = BLOCK_HEADER_H + TABLE_HEADER_H + r.days.length * DAY_ROW_H;
    // Keep a customer's whole block on one page where it reasonably can
    // fit (every real block here is well under a page); if it can't
    // fit in what's left, start fresh rather than splitting mid-table.
    if (y - blockH < MARGIN && y < PAGE_H - MARGIN - blockH) newPage();

    // ── Block header: Name — Plan | Rate | Previous
    page.drawRectangle({ x: MARGIN, y: y - BLOCK_HEADER_H, width: gridW, height: BLOCK_HEADER_H, color: NAVY });
    page.drawText(pdfSafe(`${r.customerName} — ${r.planName}`), { x: MARGIN + 8, y: y - 13, size: 10, font: bold, color: rgb(1, 1, 1) });
    const rateLabel = `Rate: ${fmtNairaPDF(r.rate)}`;
    const prevLabel = `Previous: ${r.previousFraction}`;
    const prevX = MARGIN + gridW - 8 - font.widthOfTextAtSize(prevLabel, 8);
    const rateX = prevX - 16 - font.widthOfTextAtSize(rateLabel, 8);
    page.drawText(rateLabel, { x: rateX, y: y - 13, size: 8, font, color: rgb(0.85, 0.88, 0.98) });
    page.drawText(prevLabel, { x: prevX, y: y - 13, size: 8, font: bold, color: rgb(1, 0.729, 0.035) });
    y -= BLOCK_HEADER_H;

    // ── Mini table header: DATE | AMOUNT | NO.
    page.drawRectangle({ x: MARGIN, y: y - TABLE_HEADER_H, width: gridW, height: TABLE_HEADER_H, color: rgb(0.9, 0.92, 0.97) });
    page.drawText('DATE', { x: MARGIN + 6, y: y - 11.5, size: 7, font: bold, color: GREY });
    const amtHead = 'AMOUNT';
    page.drawText(amtHead, { x: MARGIN + DATE_W + AMOUNT_W - 6 - bold.widthOfTextAtSize(amtHead, 7), y: y - 11.5, size: 7, font: bold, color: GREY });
    const noHead = 'NO.';
    page.drawText(noHead, { x: MARGIN + DATE_W + AMOUNT_W + NO_W - 6 - bold.widthOfTextAtSize(noHead, 7), y: y - 11.5, size: 7, font: bold, color: GREY });
    y -= TABLE_HEADER_H;

    // ── Day rows
    r.days.forEach((day, i) => {
      if (y - DAY_ROW_H < MARGIN) newPage();
      if (i % 2 === 0) page.drawRectangle({ x: MARGIN, y: y - DAY_ROW_H, width: gridW, height: DAY_ROW_H, color: LIGHT_BG });

      page.drawText(day.dateLabel, { x: MARGIN + 8, y: y - 11, size: 8, font, color: BLACK });

      const amtStr = fmtNairaPDF(day.amount);
      page.drawText(amtStr, { x: MARGIN + DATE_W + AMOUNT_W - 8 - font.widthOfTextAtSize(amtStr, 8), y: y - 11, size: 8, font, color: day.amount ? BLACK : GREY });

      const noStr = day.noFraction;
      page.drawText(noStr, { x: MARGIN + DATE_W + AMOUNT_W + NO_W - 8 - bold.widthOfTextAtSize(noStr, 8.5), y: y - 11, size: 8.5, font: bold, color: GREEN });

      y -= DAY_ROW_H;
    });

    y -= BLOCK_GAP;
  });

  if (y - 24 < MARGIN) newPage();
  y -= 4;
  page.drawText("No. = previous business day's No. + that day's payment / Rate. The first row of a new month starts", { x: MARGIN, y, size: 7, font, color: GREY });
  y -= 9;
  page.drawText("from Previous instead — last month's final No., carried forward until the plan is withdrawn/closed.", { x: MARGIN, y, size: 7, font, color: GREY });

  return Buffer.from(await pdfDoc.save()).toString('base64');
}

// ─── SEND EMAIL ────────────────────────────────────────────────────────────

async function sendEmail(html, pdfBase64, d) {
  const from = RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';

  let to = [];
  try {
    const rows = await fetchRows('report_recipients', 'select=email');
    to = rows.map(r => r.email).filter(Boolean);
  } catch (e) {
    console.error('Could not fetch report_recipients, falling back to secret:', e.message);
  }
  if (!to.length && ADMIN_EMAILS) to = ADMIN_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
  if (!to.length) {
    console.log('No recipients configured (add one in Admin → Settings → Email Reports). Skipping send.');
    await insertAuditLog({
      action: 'logbook_report_skipped', user_role: 'system',
      description: 'Cumulative logbook not sent — no recipients configured.',
    });
    return;
  }

  const dateStr = NOW.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: `WAG Cumulative Logbook — ${dateStr}`,
      html,
      attachments: [{ filename: `WAG-Logbook-${d.YEAR_MONTH}-${pad2(d.D)}.pdf`, content: pdfBase64 }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Resend error:', errText);
    await insertAuditLog({
      action: 'logbook_report_failed', user_role: 'system',
      description: `Cumulative logbook send failed: ${errText.slice(0, 300)}`,
    });
    process.exit(1);
  }
  console.log(`Cumulative logbook sent successfully to: ${to.join(', ')}`);
  await insertAuditLog({
    action: 'logbook_report_sent', user_role: 'system',
    description: `Cumulative logbook sent to ${to.length} recipient(s): ${to.join(', ')}`,
  });
}

// ─── RUN ───────────────────────────────────────────────────────────────────

(async () => {
  const data = await gatherLedgerData();
  const html = buildHTML(data);
  const pdfBase64 = await buildPDF(data);
  await sendEmail(html, pdfBase64, data);
})().catch(async (e) => {
  console.error('Fatal error generating logbook:', e);
  try {
    await insertAuditLog({ action: 'logbook_report_failed', user_role: 'system', description: `Fatal error: ${String(e).slice(0, 300)}` });
  } catch (_) { /* best-effort */ }
  process.exit(1);
});
