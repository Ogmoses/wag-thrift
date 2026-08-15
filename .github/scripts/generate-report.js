/**
 * WAG Enterprises — Cumulative Daily Logbook
 *
 * Generates the daily field-logbook report — one row per active customer
 * plan, showing today's payment against the agreed Rate and a running
 * cumulative slot count ("No.") that carries forward day to day and
 * month to month — and emails it to the admin(s) via Resend as a PDF.
 * Sent Monday through Friday at 9:00 PM WAT.
 *
 * Columns, left to right (this is deliberately NOT a day-by-day grid —
 * there is no per-day breakdown and no separate "Total" column; "No." IS
 * the running total, carried forward from report to report):
 *   Name      — customer name (plan name shown as a sub-label, since one
 *               customer can hold several plans at different rates)
 *   Rate      — the agreed daily amount for this plan
 *   Amount    — the money actually paid TODAY (can be more or less than
 *               Rate — e.g. Rate ₦1,000, paid ₦2,000, or paid ₦500)
 *   No.       — cumulative slots as of today: Previous + every confirmed
 *               deposit this month divided by Rate, expressed as a
 *               traditional fraction (½ etc.). Accumulates day by day —
 *               a ₦500 payment today completes a ₦500 half-slot from
 *               three days ago the same way a ₦1,000 payment would.
 *   Previous  — the closing No. from last month. Fixed all month; the
 *               new month's No. starts accumulating from here.
 *
 * This REPLACES both the old generic daily/weekly Cash Report AND the
 * first cut of this report (a landscape grid with one column per
 * business day) — see MIGRATION NOTES.md for history. Still separate
 * from the raw SQL backup (db-backup.yml), which is for disaster
 * recovery, not day-to-day reading.
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
// Used only for the "business day N of month" header label.
function businessDaysSoFar(year, month0, uptoDay) {
  let n = 0;
  for (let d = 1; d <= uptoDay; d++) if (isBusinessDay(year, month0, d)) n++;
  return n;
}
function prevYearMonth(year, month0) { return month0 === 0 ? { year: year - 1, month0: 11 } : { year, month0: month0 - 1 }; }

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

// ─── GATHER: active plans, today's + month-to-date deposits, carryover ───

async function gatherLedgerData() {
  const { year: Y, month0: M0, day: D } = toWATParts(NOW);
  const YEAR_MONTH = yearMonthKeyOf({ year: Y, month0: M0 });
  const { year: PY, month0: PM0 } = prevYearMonth(Y, M0);
  const PREV_YEAR_MONTH = yearMonthKeyOf({ year: PY, month0: PM0 });
  const TODAY_KEY = watDateKey(NOW);
  const businessDayNum = businessDaysSoFar(Y, M0, D);

  const [activeCustomers, activePlans] = await Promise.all([
    fetchRows('customers', 'status=eq.active&select=id,first_name,last_name'),
    fetchRows('plans', 'status=eq.active&select=id,customer_id,name,regular_contribution,created_at&order=created_at.asc'),
  ]);
  const custMap = {};
  activeCustomers.forEach(c => { custMap[c.id] = c; });
  // Only plans belonging to an active customer — a suspended customer's
  // plan isn't being actively collected against, so it doesn't belong in
  // today's field logbook.
  const plans = activePlans.filter(p => custMap[p.customer_id]);

  if (!plans.length) {
    return { Y, M0, D, YEAR_MONTH, businessDayNum, rows: [], grandTodayNaira: 0 };
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

  // ── This month's confirmed deposits for every active plan. No is a
  // running cumulative, not a per-day breakdown, so this just needs two
  // sums per plan: everything so far this month (for No.), and today's
  // slice of that (for Amount) — no day-by-day bucketing needed.
  const monthStartISO = watMidnightUTC(Y, M0, 1).toISOString();
  const monthTx = await fetchRows(
    'transactions',
    `plan_id=in.(${plans.map(p => p.id).join(',')})&status=eq.confirmed&type=in.(opening,deposit)&created_at=gte.${monthStartISO}&created_at=lte.${NOW.toISOString()}&select=plan_id,amount,created_at`
  );
  const monthSumByPlan = {};
  const todaySumByPlan = {};
  monthTx.forEach(t => {
    monthSumByPlan[t.plan_id] = (monthSumByPlan[t.plan_id] || 0) + Number(t.amount);
    if (watDateKey(new Date(t.created_at)) === TODAY_KEY) {
      todaySumByPlan[t.plan_id] = (todaySumByPlan[t.plan_id] || 0) + Number(t.amount);
    }
  });

  let grandTodayNaira = 0;
  const rows = plans.map(plan => {
    const cust = custMap[plan.customer_id];
    const rate = Number(plan.regular_contribution);
    const amountToday = todaySumByPlan[plan.id] || 0;
    const monthAmount = monthSumByPlan[plan.id] || 0;
    const previousSlots = previousByPlan[plan.id] || 0;
    const cumulativeSlots = previousSlots + monthAmount / rate;
    grandTodayNaira += amountToday;
    return {
      customerName: `${cust.first_name} ${cust.last_name}`,
      planName: plan.name,
      rate,
      amountToday,
      noFraction: formatSlotFraction(cumulativeSlots),
      previousFraction: formatSlotFraction(previousSlots),
    };
  }).sort((a, b) => a.customerName.localeCompare(b.customerName) || a.planName.localeCompare(b.planName));

  return { Y, M0, D, YEAR_MONTH, businessDayNum, rows, grandTodayNaira };
}

// ─── BUILD HTML EMAIL ──────────────────────────────────────────────────────

function buildHTML(d) {
  const dateLabel = new Date(Date.UTC(d.Y, d.M0, d.D)).toLocaleDateString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const rowsHTML = d.rows.length
    ? d.rows.map(r => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;color:#111827;">
          <div style="font-weight:700;">${r.customerName}</div>
          <div style="font-size:10px;color:#9ca3af;">${r.planName}</div>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#374151;">${fmtNaira(r.rate)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#374151;">${fmtNaira(r.amountToday)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:13px;font-weight:800;text-align:right;color:#011f7b;">${r.noFraction}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;text-align:right;color:#9ca3af;">${r.previousFraction}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="padding:14px;text-align:center;color:#9ca3af;font-size:12px;">No active customer plans yet.</td></tr>`;

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#f4f6fb;padding:24px 16px;">
    <div style="background:#011f7b;border-radius:14px 14px 0 0;padding:24px 28px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="color:#FFBA09;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Wonderful &amp; Able God Enterprises</div>
        <div style="color:#8a97c2;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid #2a3a7a;border-radius:4px;padding:2px 7px;">Confidential</div>
      </div>
      <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px;">Daily Cumulative Logbook</div>
      <div style="color:#c7d2ea;font-size:13px;margin-top:4px;">${dateLabel} — Business day ${d.businessDayNum} of ${d.YEAR_MONTH}</div>
    </div>
    <div style="background:#fff;padding:24px 28px;">
      <div style="background:#f0f4ff;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">Deposited Today</div>
        <div style="font-size:22px;font-weight:800;color:#011f7b;">${fmtNaira(d.grandTodayNaira)}</div>
      </div>
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Customer Ledger (${d.rows.length} active plan${d.rows.length === 1 ? '' : 's'})</div>
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
        No. is the running cumulative slot count (Previous + every confirmed payment this month ÷ Rate) — it carries<br>
        forward automatically day to day and month to month. A full-page printable copy is attached as a PDF.<br>
        This report covers deposit activity only. The full admin audit trail stays in-app under Admin → Settings → Audit Log.
      </p>
    </div>
  </div>`;
}

// ─── BUILD PDF (Portrait Daily Ledger) ────────────────────────────────────

async function buildPDF(d) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.004, 0.122, 0.482);
  const GOLD = rgb(0.7, 0.5, 0);
  const GREY = rgb(0.42, 0.45, 0.5);
  const BLACK = rgb(0.07, 0.09, 0.14);
  const GREEN = rgb(0.08, 0.5, 0.18);
  const PAGE_W = 595, PAGE_H = 842, MARGIN = 40; // A4 portrait, points

  const NAME_W = 190, RATE_W = 85, AMOUNT_W = 95, NO_W = 75;
  const PREV_W = PAGE_W - MARGIN * 2 - (NAME_W + RATE_W + AMOUNT_W + NO_W);
  const gridW = PAGE_W - MARGIN * 2;

  const HEADER_ROW_H = 22;
  const ROW_H = 26;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const dateLabel = new Date(Date.UTC(d.Y, d.M0, d.D)).toLocaleDateString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  function drawPageTop() {
    page.drawText('WONDERFUL & ABLE GOD ENTERPRISES', { x: MARGIN, y, size: 10, font: bold, color: GOLD });
    const conf = 'CONFIDENTIAL';
    page.drawText(conf, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(conf, 8), y, size: 8, font: bold, color: GREY });
    y -= 20;
    page.drawText(`Daily Cumulative Logbook - ${dateLabel}`, { x: MARGIN, y, size: 14, font: bold, color: NAVY });
    y -= 16;
    const sub = `Business day ${d.businessDayNum} of ${d.YEAR_MONTH}   |   Deposited today: ${fmtNairaPDF(d.grandTodayNaira)}   |   Active plans: ${d.rows.length}`;
    page.drawText(sub, { x: MARGIN, y, size: 8.5, font, color: GREY });
    y -= 18;
  }

  function drawGridHeader() {
    page.drawRectangle({ x: MARGIN, y: y - HEADER_ROW_H, width: gridW, height: HEADER_ROW_H, color: NAVY });
    let x = MARGIN;
    const headCell = (label, w, rightAlign) => {
      const tx = rightAlign ? x + w - 6 - bold.widthOfTextAtSize(label, 8) : x + 6;
      page.drawText(label, { x: tx, y: y - 14, size: 8, font: bold, color: rgb(1, 1, 1) });
      x += w;
    };
    headCell('NAME', NAME_W, false);
    headCell('RATE', RATE_W, true);
    headCell('AMOUNT', AMOUNT_W, true);
    headCell('NO.', NO_W, true);
    headCell('PREVIOUS', PREV_W, true);
    y -= HEADER_ROW_H;
  }

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
    drawPageTop();
    drawGridHeader();
  }

  drawPageTop();
  drawGridHeader();

  if (!d.rows.length) {
    page.drawText('No active customer plans yet.', { x: MARGIN + 6, y: y - 15, size: 9, font, color: GREY });
    y -= ROW_H;
  }

  d.rows.forEach((r, i) => {
    if (y - ROW_H < MARGIN + 24) newPage();
    if (i % 2 === 0) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: gridW, height: ROW_H, color: rgb(0.97, 0.98, 1) });

    let x = MARGIN;
    page.drawText(pdfSafe(r.customerName), { x: x + 6, y: y - 12, size: 9, font: bold, color: BLACK });
    page.drawText(pdfSafe(r.planName), { x: x + 6, y: y - 22, size: 7, font, color: GREY });
    x += NAME_W;

    const rateStr = fmtNairaPDF(r.rate);
    page.drawText(rateStr, { x: x + RATE_W - 6 - font.widthOfTextAtSize(rateStr, 8.5), y: y - 16, size: 8.5, font, color: BLACK });
    x += RATE_W;

    const amtStr = fmtNairaPDF(r.amountToday);
    page.drawText(amtStr, { x: x + AMOUNT_W - 6 - font.widthOfTextAtSize(amtStr, 8.5), y: y - 16, size: 8.5, font, color: r.amountToday ? BLACK : GREY });
    x += AMOUNT_W;

    const noStr = r.noFraction;
    page.drawText(noStr, { x: x + NO_W - 6 - bold.widthOfTextAtSize(noStr, 9.5), y: y - 16, size: 9.5, font: bold, color: GREEN });
    x += NO_W;

    const prevStr = r.previousFraction;
    page.drawText(prevStr, { x: x + PREV_W - 6 - font.widthOfTextAtSize(prevStr, 8.5), y: y - 16, size: 8.5, font, color: GREY });

    y -= ROW_H;
  });

  if (y - 26 < MARGIN) newPage();
  y -= 8;
  page.drawText("No. = Previous + every confirmed payment this month / Rate, as a fraction. It carries forward day to day", { x: MARGIN, y, size: 7, font, color: GREY });
  y -= 10;
  page.drawText("and month to month; Previous is fixed for the whole month and only changes when a new month begins.", { x: MARGIN, y, size: 7, font, color: GREY });

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
