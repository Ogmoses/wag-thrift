/**
 * WAG Enterprises — Cumulative Daily Logbook
 *
 * Generates the daily field-logbook report and emails it to the admin(s)
 * via Resend as a landscape PDF. Sent Monday through Friday at 9:00 PM WAT.
 *
 * Layout: ONE ROW PER CUSTOMER PLAN (not one row per day — that doesn't
 * scale past a few dozen customers). Business days of the current month
 * become COLUMNS instead, so the whole roster fits in a compact grid:
 *
 *   NAME              RATE      PREV   Mon 3   Tue 4   Wed 5   Thu 6  ...
 *   Bola Tunde         1,500      0             ·       7,500   1,500
 *   — Shop rent                                          5       6
 *
 * Each day cell stacks two things: that day's Amount (small, only shown
 * when nonzero — a day with nothing paid just shows the No.) and the
 * running No. as of that day (bold — No. from the day before + that
 * day's payment ÷ Rate). No separate "Total" column: the rightmost
 * (today's) day column already IS the current No., the same way the
 * last line of a passbook page is its own running balance.
 *
 * This REPLACES three earlier cuts of this report — a landscape grid
 * with per-day columns but no cumulative No. inside them, a flat
 * one-row-per-customer snapshot, and a one-row-per-day passbook block
 * per customer (which is correct but doesn't scale past a few dozen
 * customers: at 1,000+ active plans it becomes tens of thousands of
 * rows). See MIGRATION NOTES.md for history. Still separate from the
 * raw SQL backup (db-backup.yml), which is for disaster recovery, not
 * day-to-day reading.
 *
 * SCALE NOTES (this matters once the roster is in the hundreds/thousands):
 *  - Every Supabase filter that used to take one plan_id now takes the
 *    whole list, chunked into batches of ~150 so the request URL never
 *    gets anywhere near typical length limits (1,000 raw UUIDs would be
 *    ~37KB in one query string).
 *  - "Is last month already closed for this plan?" used to be one
 *    query PER PLAN, every single day, even on days when the answer is
 *    "yes" for literally everyone (every day except the first business
 *    day of a new month). That's now a single batched query; the
 *    per-plan gap-closing work below it only ever runs for plans that
 *    actually need it — which in steady state is zero.
 *  - The (rare) plans that do need closing are processed with bounded
 *    concurrency (CONCURRENCY below), not one giant Promise.all over
 *    the whole roster, so a month-boundary run doesn't fire 1,000+
 *    simultaneous requests at Supabase at once.
 *  - Not yet handled: if a single chunk's month-to-date transaction
 *    fetch itself returns more rows than Supabase's default per-request
 *    row cap (1,000), that fetch would come back truncated. Not an
 *    issue at today's data volume; if the roster and payment frequency
 *    grow enough to hit it, fetchRows needs Range-header pagination
 *    added (loop using the Content-Range response header until a
 *    partial page comes back).
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
const ID_CHUNK_SIZE = 150; // plan_ids per in.(...) filter — keeps URLs well under length limits
const CONCURRENCY = 25;    // max simultaneous requests when closing out plans at month boundary

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

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Same as fetchRows, but for a filter keyed on a big list of ids —
// chunks the list so no single request URL gets too long, and merges
// the results back into one array.
async function fetchRowsForIds(table, idField, ids, restOfParams) {
  if (!ids.length) return [];
  const chunks = chunkArray(ids, ID_CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map(chunk => fetchRows(table, `${idField}=in.(${chunk.join(',')})&${restOfParams}`))
  );
  return results.flat();
}

// Runs fn over items with at most `limit` in flight at once, instead of
// firing the whole list at Supabase simultaneously via Promise.all.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
// Compact, no-currency-symbol number for inside the narrow day cells —
// repeating "NGN"/"₦" in a grid with 1,000 rows × 23 columns would be
// pure noise; the RATE column already establishes the currency.
function fmtCompact(n) { return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
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
  // plan isn't being actively collected against. "till the person
  // finally withdraws and stops the plan" — once closed/deleted it
  // drops off here too, since it's no longer status=active.
  const plans = activePlans.filter(p => custMap[p.customer_id]);
  const planIds = plans.map(p => p.id);

  const dayList = businessDaysInMonth(Y, M0, D);
  const dayKeys = dayList.map(dayKeyOf);
  const dayKeySet = new Set(dayKeys);
  // Assigns a transaction to the nearest visible business-day column on
  // or after its real WAT date (rolls a weekend transaction forward to
  // the next business day; clamps to the last column if "today" itself
  // is a weekend). Guarantees, by construction, that a plan's day
  // columns always sum to exactly its final No. — no money is ever
  // silently missing from the printed grid.
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
  // its carryover. In steady state (every day except the 1st business
  // day of a new month) every plan is already closed, so this is one
  // batched query, not one per plan. Self-healing: any plan that isn't
  // closed yet (first-ever run, a newly created plan, or the report
  // having missed a while) walks back to the most recent CLOSED month
  // on file — or the beginning of the plan's history if none — and
  // sums every confirmed opening/deposit transaction in the gap, so the
  // baseline is always correct off the immutable transaction log.
  const closedRows = await fetchRowsForIds('monthly_ledgers', 'plan_id', planIds, `year_month=eq.${PREV_YEAR_MONTH}&select=plan_id`);
  const closedSet = new Set(closedRows.map(r => r.plan_id));
  const needsClosing = plans.filter(p => !closedSet.has(p.id));

  await mapWithConcurrency(needsClosing, CONCURRENCY, async (plan) => {
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
      `plan_id=eq.${plan.id}&status=eq.confirmed&type=in.(opening,deposit)&created_at=gt.${sinceISO}&created_at=lte.${untilISO}&select=amount,method`
    );
    // A migrated opening transaction (method='Migrated') is a paper-ledger
    // carryover, not a digital day-by-day contribution — excluded from
    // slot math the same way customer.js excludes it from the customer's
    // own calendar (see that file for the full reasoning). Filtered in
    // JS rather than the query string: method is nullable, and PostgREST's
    // neq compiles to SQL <>, which silently drops NULL rows instead of
    // keeping them — !== here has no such gotcha.
    const gapAmount = gapTx.filter(t => t.method !== 'Migrated').reduce((s, t) => s + Number(t.amount), 0);
    const closingSlots = baseSlots + gapAmount / Number(plan.regular_contribution);
    await insertIgnoreDuplicate('monthly_ledgers', {
      plan_id: plan.id, customer_id: plan.customer_id, year_month: PREV_YEAR_MONTH, closing_slots: closingSlots,
    });
  });

  const previousRows = await fetchRowsForIds('monthly_ledgers', 'plan_id', planIds, `year_month=eq.${PREV_YEAR_MONTH}&select=plan_id,closing_slots`);
  const previousByPlan = {};
  previousRows.forEach(r => { previousByPlan[r.plan_id] = Number(r.closing_slots); });

  // ── This month's confirmed deposits for every active plan, bucketed
  // by business-day column. Migrated opening transactions are excluded
  // here too — same reasoning as the gap-closing query above.
  const monthStartISO = watMidnightUTC(Y, M0, 1).toISOString();
  const monthTx = await fetchRowsForIds(
    'transactions', 'plan_id', planIds,
    `status=eq.confirmed&type=in.(opening,deposit)&created_at=gte.${monthStartISO}&created_at=lte.${NOW.toISOString()}&select=plan_id,amount,created_at,method&order=created_at.asc`
  );
  const bucket = {}; // planId -> dayKey -> naira amount
  monthTx.filter(t => t.method !== 'Migrated').forEach(t => {
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

    // Running cumulative — each day starts from wherever the day before
    // left off, and the very first day of the month starts from
    // Previous. This loop IS "yesterday's No. + today's slots".
    let running = previousSlots;
    const days = dayList.map((dd, i) => {
      const key = dayKeys[i];
      const amount = planBucket[key] || 0;
      running += amount / rate;
      return { amount, noFraction: formatSlotFraction(running) };
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
// the full day-by-day grid (the part that grows through the month) is
// in the attached PDF, which is what's meant to be printed and filed.

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
        This is today's line only. The attached PDF has the full grid for ${d.YEAR_MONTH} — every active<br>
        customer as a row, every business day so far this month as a column, No. accumulating across.<br>
        This report covers deposit activity only. The full admin audit trail stays in-app under Admin → Settings → Audit Log.
      </p>
    </div>
  </div>`;
}

// ─── BUILD PDF (Landscape grid — customers as rows, days as columns) ─────

async function buildPDF(d) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.004, 0.122, 0.482);
  const GOLD = rgb(0.7, 0.5, 0);
  const GREY = rgb(0.42, 0.45, 0.5);
  const BLACK = rgb(0.07, 0.09, 0.14);
  const GREEN = rgb(0.08, 0.5, 0.18);
  const PAGE_W = 842, PAGE_H = 595, MARGIN = 24; // A4 landscape, points

  const NAME_W = 115, RATE_W = 42, PREV_W = 38;
  const fixedW = NAME_W + RATE_W + PREV_W;
  const availableForDays = PAGE_W - MARGIN * 2 - fixedW;
  const numDays = Math.max(d.dayList.length, 1);
  const dayW = Math.min(34, Math.max(16, Math.floor(availableForDays / numDays)));
  const gridW = fixedW + dayW * d.dayList.length;

  const HEADER_ROW_H = 24;
  const ROW_H = 22;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const dateLabel = new Date(Date.UTC(d.Y, d.M0, d.D)).toLocaleDateString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const WEEKDAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  function drawPageTop() {
    page.drawText('WONDERFUL & ABLE GOD ENTERPRISES', { x: MARGIN, y, size: 10, font: bold, color: GOLD });
    const conf = 'CONFIDENTIAL';
    page.drawText(conf, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(conf, 8), y, size: 8, font: bold, color: GREY });
    y -= 16;
    page.drawText(`Daily Cumulative Logbook - ${dateLabel}`, { x: MARGIN, y, size: 13, font: bold, color: NAVY });
    y -= 14;
    const sub = `Business day ${d.dayList.length} of ${d.YEAR_MONTH}   |   Deposited today: ${fmtNairaPDF(d.grandTodayNaira)}   |   Active plans: ${d.rows.length}`;
    page.drawText(sub, { x: MARGIN, y, size: 8, font, color: GREY });
    y -= 14;
  }

  function drawGridHeader() {
    page.drawRectangle({ x: MARGIN, y: y - HEADER_ROW_H, width: gridW, height: HEADER_ROW_H, color: NAVY });
    let x = MARGIN;
    const headCell = (label, w, rightAlign) => {
      const tx = rightAlign ? x + w - 5 - bold.widthOfTextAtSize(label, 7.5) : x + 5;
      page.drawText(label, { x: tx, y: y - 15, size: 7.5, font: bold, color: rgb(1, 1, 1) });
      x += w;
    };
    headCell('NAME', NAME_W, false);
    headCell('RATE', RATE_W, true);
    headCell('PREV', PREV_W, true);
    d.dayList.forEach(dd => {
      const wd = WEEKDAY_INITIAL[calendarWeekday(dd.year, dd.month0, dd.day)];
      const wdX = x + dayW / 2 - font.widthOfTextAtSize(wd, 6) / 2;
      page.drawText(wd, { x: wdX, y: y - 9, size: 6, font, color: rgb(0.75, 0.8, 0.95) });
      const dnum = String(dd.day);
      const dnumX = x + dayW / 2 - bold.widthOfTextAtSize(dnum, 7) / 2;
      page.drawText(dnum, { x: dnumX, y: y - 18, size: 7, font: bold, color: rgb(1, 1, 1) });
      x += dayW;
    });
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
    page.drawText('No active customer plans yet.', { x: MARGIN + 6, y: y - 14, size: 9, font, color: GREY });
    y -= ROW_H;
  }

  d.rows.forEach((r, i) => {
    if (y - ROW_H < MARGIN + 18) newPage();
    if (i % 2 === 0) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: gridW, height: ROW_H, color: rgb(0.97, 0.98, 1) });

    let x = MARGIN;
    page.drawText(pdfSafe(r.customerName), { x: x + 5, y: y - 9, size: 7.5, font: bold, color: BLACK });
    page.drawText(pdfSafe(r.planName), { x: x + 5, y: y - 18, size: 6, font, color: GREY });
    x += NAME_W;

    const rateStr = fmtCompact(r.rate);
    page.drawText(rateStr, { x: x + RATE_W - 5 - font.widthOfTextAtSize(rateStr, 7), y: y - 14, size: 7, font, color: BLACK });
    x += RATE_W;

    const prevStr = r.previousFraction;
    page.drawText(prevStr, { x: x + PREV_W - 5 - font.widthOfTextAtSize(prevStr, 7), y: y - 14, size: 7, font, color: GREY });
    x += PREV_W;

    r.days.forEach(day => {
      if (day.amount) {
        const amtStr = fmtCompact(day.amount);
        const amtX = x + dayW / 2 - font.widthOfTextAtSize(amtStr, 5.5) / 2;
        page.drawText(amtStr, { x: amtX, y: y - 9, size: 5.5, font, color: GREY });
      }
      const noStr = day.noFraction;
      const noX = x + dayW / 2 - bold.widthOfTextAtSize(noStr, 7) / 2;
      page.drawText(noStr, { x: noX, y: y - 18, size: 7, font: bold, color: GREEN });
      x += dayW;
    });

    y -= ROW_H;
  });

  if (y - 22 < MARGIN) newPage();
  y -= 4;
  page.drawText("Each day cell: amount paid that day (small, blank if none) over the running No. (bold) — Previous +", { x: MARGIN, y, size: 6.5, font, color: GREY });
  y -= 8;
  page.drawText("every payment this month so far / Rate. The rightmost column is today's current No.; no separate Total column.", { x: MARGIN, y, size: 6.5, font, color: GREY });

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
