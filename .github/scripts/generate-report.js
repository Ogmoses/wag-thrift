/**
 * WAG Enterprises — Admin Activity Digest
 *
 * Generates a structured, human-readable "logbook" report of platform
 * activity over the last day or week, and emails it to the admin(s) via
 * Resend. This is separate from the raw SQL backup (db-backup.yml) — that
 * one is for disaster recovery; this one is for day-to-day transparency
 * and oversight, meant to actually be read.
 *
 * Usage: node generate-report.js daily
 *        node generate-report.js weekly
 *
 * Required environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
 *   RESEND_FROM_EMAIL, ADMIN_EMAILS (comma-separated)
 */

const REPORT_TYPE = process.argv[2] || 'daily';
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
const PERIOD_HOURS = REPORT_TYPE === 'weekly' ? 24 * 7 : 24;
const PERIOD_START = new Date(NOW.getTime() - PERIOD_HOURS * 60 * 60 * 1000);
const PERIOD_LABEL = REPORT_TYPE === 'weekly' ? 'Weekly Rollup' : 'Daily Summary';

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────

async function fetchRows(table, params) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`Failed to fetch ${table}:`, await res.text());
    return [];
  }
  return res.json();
}

async function fetchCount(table, params) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range'); // e.g. "0-0/42"
  if (!range) return 0;
  return parseInt(range.split('/')[1] || '0', 10);
}

function fmtNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

// pdf-lib's built-in Helvetica font can't encode the ₦ symbol (it's outside
// WinAnsi encoding) — this would crash PDF generation entirely if used
// there. PDFs use this ASCII-safe version instead; the HTML email keeps
// the real ₦ symbol since phones/browsers render it natively.
function fmtNairaPDF(n) {
  return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

// pdf-lib's built-in font only supports WinAnsi encoding (~Latin-1 range).
// Admin-typed text (customer names, notes) can contain characters outside
// that — smart quotes, en/em dashes, ellipses — especially likely to show
// up somewhere across a full week of entries, which is why this crashed
// on the weekly report specifically but not the daily one. This sanitizes
// anything going into PDF text so it can never crash again.
function pdfSafe(str) {
  return String(str ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/₦/g, 'NGN ')
    .replace(/[^\x00-\xFF]/g, '?');
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function sinceISO() {
  return PERIOD_START.toISOString();
}

// ─── GATHER DATA ──────────────────────────────────────────────────────────

async function gatherReport() {
  const since = sinceISO();

  const [
    newCustomers,
    newAgents,
    totalActiveCustomers,
    totalActiveAgents,
    txRows,
    disbRows,
    auditRows,
    balanceRows,
    agentRows,
  ] = await Promise.all([
    fetchCount('customers', `created_at=gte.${since}`),
    fetchCount('representatives', `created_at=gte.${since}`),
    fetchCount('customers', `status=eq.active`),
    fetchCount('representatives', `status=eq.active`),
    fetchRows('transactions', `created_at=gte.${since}&select=ref,type,amount,customer_name,agent_name,agent_id,created_at&order=created_at.asc`),
    fetchRows('disbursements', `requested_at=gte.${since}&select=status,amount,customer_name,requested_at`),
    fetchRows('audit_log', `created_at=gte.${since}&select=action,description,amount,user_id,user_role,created_at&order=created_at.asc`),
    fetchRows('plan_balances', `select=balance`),
    fetchRows('representatives', `select=id,first_name,last_name,rep_id`),
  ]);

  // Transactions summary
  const deposits = txRows.filter(t => t.type === 'deposit' || t.type === 'opening');
  const payouts = txRows.filter(t => t.type === 'payout');
  const depositTotal = deposits.reduce((s, t) => s + Number(t.amount), 0);
  const payoutTotal = payouts.reduce((s, t) => s + Number(t.amount), 0);

  // Disbursement summary
  const disbByStatus = disbRows.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {});

  // Total funds currently held across all plans (point-in-time, not period-based)
  const totalHeld = balanceRows.reduce((s, r) => s + Number(r.balance), 0);

  const agentGroups = groupByAgent(txRows, auditRows, agentRows);
  // Only true admin-authored actions (suspend/delete/restore/review/etc.)
  // — agent logins, searches, and collections now live inside each
  // agent's own section instead, so nothing is shown twice.
  const adminOnlyAuditRows = auditRows.filter(a => a.user_role !== 'representative');

  return {
    newCustomers, newAgents, totalActiveCustomers, totalActiveAgents,
    deposits, payouts, depositTotal, payoutTotal,
    disbByStatus, disbCount: disbRows.length,
    auditRows, adminOnlyAuditRows, agentGroups, totalHeld,
  };
}

// Groups this period's transactions and audit activity by the agent who
// did them — the whole point being: an admin can look at ONE agent's
// block and see everything that agent did, instead of scrolling through
// a single giant mixed list to piece it together themselves. Admin-only
// actions (suspend, delete, approve, etc.) are deliberately excluded —
// those aren't any agent's actions, so forcing them into an agent's
// section would misattribute them.
function groupByAgent(txRows, auditRows, agentRows) {
  const agentMap = {};
  (agentRows || []).forEach(a => { agentMap[a.id] = a; });

  const groups = {}; // agentId -> { agentName, repId, transactions, auditEntries, totalCollected }
  const getGroup = (agentId, fallbackName) => {
    if (!groups[agentId]) {
      const a = agentMap[agentId];
      groups[agentId] = {
        agentId,
        agentName: a ? `${a.first_name} ${a.last_name}` : (fallbackName || 'Unknown Agent'),
        repId: a?.rep_id || null,
        transactions: [],
        auditEntries: [],
        totalCollected: 0,
      };
    }
    return groups[agentId];
  };

  txRows.forEach(t => {
    if (!t.agent_id) return; // e.g. a rejected-disbursement row with no agent
    const g = getGroup(t.agent_id, t.agent_name);
    g.transactions.push(t);
    if (t.type === 'deposit' || t.type === 'opening') g.totalCollected += Number(t.amount);
  });

  auditRows.forEach(a => {
    if (a.user_role !== 'representative' || !a.user_id) return;
    const g = getGroup(a.user_id, null);
    g.auditEntries.push(a);
  });

  // Busiest agent first — the most relevant activity floats to the top
  // instead of everyone being sorted alphabetically regardless of activity.
  return Object.values(groups).sort((a, b) => b.totalCollected - a.totalCollected);
}

// ─── BUILD HTML ───────────────────────────────────────────────────────────

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ─── BUILD PDF ────────────────────────────────────────────────────────────
// A proper downloadable/printable record of this period — mainly for the
// audit logbook, since that's the part worth keeping for reference (the
// email itself is easy to lose in a crowded inbox; a PDF is easy to save,
// forward, or file away).

async function buildPDF(d) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.004, 0.122, 0.482);
  const GOLD = rgb(1, 0.729, 0.035);
  const GREY = rgb(0.42, 0.45, 0.5);
  const BLACK = rgb(0.07, 0.09, 0.14);
  const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPageIfNeeded = (need) => {
    if (y - need < MARGIN) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const text = (str, x, size, f, color) => page.drawText(String(str), { x, y, size, font: f || font, color: color || BLACK });
  const line = (h) => { y -= h; };

  // Header
  text('WONDERFUL & ABLE GOD ENTERPRISES', MARGIN, 10, bold, rgb(0.7, 0.5, 0));
  line(18);
  text(PERIOD_LABEL, MARGIN, 20, bold, NAVY);
  line(16);
  text(`${fmtDateTime(PERIOD_START.toISOString())}  -  ${fmtDateTime(NOW.toISOString())}`, MARGIN, 10, font, GREY);
  line(30);

  // Stat summary
  const stats = [
    ['New customers', String(d.newCustomers)],
    ['New agents', String(d.newAgents)],
    ['Deposits collected', `${fmtNairaPDF(d.depositTotal)} (${d.deposits.length} txn)`],
    ['Withdrawals paid', `${fmtNairaPDF(d.payoutTotal)} (${d.payouts.length} txn)`],
    ['Total funds held across all plans', fmtNairaPDF(d.totalHeld)],
    ['Active customers', String(d.totalActiveCustomers)],
    ['Active agents', String(d.totalActiveAgents)],
  ];
  text('SUMMARY', MARGIN, 11, bold, NAVY);
  line(18);
  stats.forEach(([label, value]) => {
    newPageIfNeeded(16);
    text(label, MARGIN, 10, font, BLACK);
    text(value, PAGE_W - MARGIN - bold.widthOfTextAtSize(value, 10), 10, bold, BLACK);
    line(16);
  });
  line(10);

  // Withdrawal pipeline
  newPageIfNeeded(100);
  text(`WITHDRAWAL REQUESTS THIS PERIOD (${d.disbCount} total)`, MARGIN, 11, bold, NAVY);
  line(18);
  [['Pending', d.disbByStatus.pending || 0], ['Reviewed', d.disbByStatus.reviewed || 0],
   ['Approved', d.disbByStatus.approved || 0], ['Paid', d.disbByStatus.paid || 0],
   ['Rejected', d.disbByStatus.rejected || 0]].forEach(([label, value]) => {
    newPageIfNeeded(16);
    text(label, MARGIN, 10, font, BLACK);
    text(String(value), PAGE_W - MARGIN - bold.widthOfTextAtSize(String(value), 10), 10, bold, BLACK);
    line(16);
  });
  line(14);

  // Agent activity — grouped so each agent's block is self-contained and
  // scannable, instead of one long mixed list to scroll through.
  newPageIfNeeded(60);
  text(`AGENT ACTIVITY (${d.agentGroups.length} agent${d.agentGroups.length === 1 ? '' : 's'})`, MARGIN, 11, bold, NAVY);
  line(20);

  if (!d.agentGroups.length) {
    text('No agent activity this period.', MARGIN, 10, font, GREY);
    line(20);
  } else {
    d.agentGroups.forEach(g => {
      newPageIfNeeded(50); // enough room for a header + at least one row before breaking
      // Agent header band
      page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_W - MARGIN * 2, height: 18, color: rgb(0.94, 0.96, 1) });
      text(pdfSafe(g.agentName), MARGIN + 6, 10, bold, NAVY);
      if (g.repId) text(`#${pdfSafe(g.repId)}`, MARGIN + 6 + bold.widthOfTextAtSize(pdfSafe(g.agentName), 10) + 8, 10, font, GREY);
      const totalStr = fmtNairaPDF(g.totalCollected);
      text(totalStr, PAGE_W - MARGIN - 6 - bold.widthOfTextAtSize(totalStr, 10), 10, bold, rgb(0.08, 0.5, 0.18));
      line(24);

      const gColTime = MARGIN, gColRef = MARGIN + 95, gColCust = MARGIN + 200, gColAmt = PAGE_W - MARGIN;
      text('TIME', gColTime, 8, bold, GREY);
      text('REF', gColRef, 8, bold, GREY);
      text('CUSTOMER', gColCust, 8, bold, GREY);
      text('AMOUNT', gColAmt - bold.widthOfTextAtSize('AMOUNT', 8), 8, bold, GREY);
      line(13);

      if (!g.transactions.length) {
        text('No collections this period.', gColTime, 8.5, font, GREY);
        line(15);
      } else {
        g.transactions.forEach(t => {
          newPageIfNeeded(15);
          const isIn = t.type === 'deposit' || t.type === 'opening';
          const amtStr = `${isIn ? '+' : '-'}${fmtNairaPDF(t.amount)}`;
          text(fmtDateTime(t.created_at), gColTime, 8, font, GREY);
          text(pdfSafe(t.ref || '-'), gColRef, 8, font, BLACK);
          text(pdfSafe(t.customer_name || 'Customer'), gColCust, 8, font, BLACK);
          text(amtStr, gColAmt - bold.widthOfTextAtSize(amtStr, 8), 8, bold, isIn ? rgb(0.08, 0.5, 0.18) : rgb(0.73, 0.11, 0.11));
          line(13);
        });
      }
      if (g.auditEntries.length) {
        newPageIfNeeded(13);
        text(pdfSafe(`${g.auditEntries.length} other activity: ${g.auditEntries.map(a => a.action).join(', ')}`), gColTime, 7.5, font, GREY);
        line(13);
      }
      line(10); // gap before the next agent's block
    });
  }
  line(10);

  // Admin actions — suspend/delete/restore/review/etc. Agent logins,
  // searches, and collections live inside each agent's own section
  // above instead, so nothing appears twice.
  newPageIfNeeded(60);
  text('ADMIN ACTIONS', MARGIN, 11, bold, NAVY);
  line(18);
  const colTime = MARGIN, colAction = MARGIN + 110, colDetails = MARGIN + 190;
  text('TIME', colTime, 9, bold, GREY);
  text('ACTION', colAction, 9, bold, GREY);
  text('DETAILS', colDetails, 9, bold, GREY);
  line(20);
  page.drawLine({ start: { x: MARGIN, y: y + 6 }, end: { x: PAGE_W - MARGIN, y: y + 6 }, thickness: 0.5, color: GREY });
  line(8);

  if (!d.adminOnlyAuditRows.length) {
    line(16);
    text('No admin actions logged this period.', MARGIN, 10, font, GREY);
  } else {
    d.adminOnlyAuditRows.forEach(a => {
      newPageIfNeeded(30);
      const details = pdfSafe(a.description || '-');
      const wrapped = details.length > 60 ? details.slice(0, 57) + '...' : details;
      text(fmtDateTime(a.created_at), colTime, 8.5, font, GREY);
      text(pdfSafe((a.action || '').toUpperCase()), colAction, 8.5, bold, NAVY);
      text(wrapped, colDetails, 8.5, font, BLACK);
      line(16);
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString('base64');
}

// ─── BUILD EMAIL HTML ─────────────────────────────────────────────────────

function icon(name, color) {
  const paths = {
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    x: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  };
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;margin-right:6px;">${paths[name]}</svg>`;
}

function buildHTML(d) {
  const adminAuditRowsHTML = d.adminOnlyAuditRows.length
    ? d.adminOnlyAuditRows.map(a => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;white-space:nowrap;">${fmtDateTime(a.created_at)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;">
            <span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:10px;text-transform:uppercase;
              background:${a.action === 'delete' ? '#fee2e2' : a.action === 'flag' ? '#fef3c7' : '#e0e7ff'};
              color:${a.action === 'delete' ? '#b91c1c' : a.action === 'flag' ? '#92400e' : '#3730a3'};">
              ${a.action}
            </span>
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${a.description || '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:14px;text-align:center;color:#9ca3af;font-size:13px;">No admin actions logged this period.</td></tr>`;

  // One compact block per agent — their deposits/withdrawals table, plus
  // a short activity line (logins, searches) underneath. Sorted busiest
  // agent first, so scanning top-to-bottom is itself useful, not just
  // alphabetical.
  const agentSectionsHTML = d.agentGroups.length
    ? d.agentGroups.map(g => {
        const txHTML = g.transactions.length
          ? g.transactions.map(t => {
              const isIn = t.type === 'deposit' || t.type === 'opening';
              return `<tr>
                <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;color:#6b7280;white-space:nowrap;">${fmtDateTime(t.created_at)}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;font-family:monospace;color:#374151;">${t.ref || '—'}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;color:#111827;">${t.customer_name || 'Customer'}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:12px;font-weight:700;text-align:right;color:${isIn ? '#15803d' : '#b91c1c'};">${isIn ? '+' : '-'}${fmtNaira(t.amount)}</td>
              </tr>`;
            }).join('')
          : `<tr><td colspan="4" style="padding:10px;text-align:center;color:#9ca3af;font-size:12px;">No collections this period.</td></tr>`;

        return `
        <div style="margin-top:16px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
          <div style="background:#f0f4ff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <span style="font-weight:700;font-size:13px;color:#011f7b;">${g.agentName}</span>
              ${g.repId ? `<span style="font-size:11px;color:#6b7280;margin-left:6px;">#${g.repId}</span>` : ''}
            </div>
            <span style="font-size:13px;font-weight:800;color:#15803d;">${fmtNaira(g.totalCollected)}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;background:#fff;">
            <thead>
              <tr style="background:#fafafa;">
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase;">Time</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase;">Ref</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase;">Customer</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase;">Amount</th>
              </tr>
            </thead>
            <tbody>${txHTML}</tbody>
          </table>
          ${g.auditEntries.length ? `<div style="padding:8px 14px;background:#fafafa;font-size:11px;color:#6b7280;border-top:1px solid #f0f2f5;">${g.auditEntries.length} other activity: ${g.auditEntries.map(a => a.action).join(', ')}</div>` : ''}
        </div>`;
      }).join('')
    : `<div style="padding:14px;text-align:center;color:#9ca3af;font-size:13px;border:1px solid #e5e7eb;border-radius:10px;">No agent activity this period.</div>`;

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#f4f6fb;padding:24px 16px;">
    <div style="background:#011f7b;border-radius:14px 14px 0 0;padding:24px 28px;">
      <div style="color:#FFBA09;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Wonderful &amp; Able God Enterprises</div>
      <div style="color:#fff;font-size:22px;font-weight:800;">${PERIOD_LABEL}</div>
      <div style="color:#c7d2ea;font-size:13px;margin-top:4px;">${fmtDateTime(PERIOD_START.toISOString())} — ${fmtDateTime(NOW.toISOString())}</div>
    </div>

    <div style="background:#fff;padding:24px 28px;">
      <!-- Overview stat grid -->
      <table style="width:100%;border-collapse:separate;border-spacing:8px 8px;margin:-8px;">
        <tr>
          <td style="width:50%;background:#f0f4ff;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">New Customers</div>
            <div style="font-size:22px;font-weight:800;color:#011f7b;">${d.newCustomers}</div>
          </td>
          <td style="width:50%;background:#f0f4ff;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">New Agents</div>
            <div style="font-size:22px;font-weight:800;color:#011f7b;">${d.newAgents}</div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff8e8;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:700;">Deposits Collected</div>
            <div style="font-size:20px;font-weight:800;color:#111827;">${fmtNaira(d.depositTotal)}</div>
            <div style="font-size:11px;color:#6b7280;">${d.deposits.length} transaction(s)</div>
          </td>
          <td style="background:#fff8e8;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:700;">Withdrawals Paid</div>
            <div style="font-size:20px;font-weight:800;color:#111827;">${fmtNaira(d.payoutTotal)}</div>
            <div style="font-size:11px;color:#6b7280;">${d.payouts.length} transaction(s)</div>
          </td>
        </tr>
      </table>

      <!-- Platform totals (point-in-time) -->
      <div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Platform Snapshot (as of now)</div>
        <table style="width:100%;font-size:13px;">
          <tr><td style="padding:3px 0;color:#374151;">Total funds held across all plans</td><td style="text-align:right;font-weight:700;color:#011f7b;">${fmtNaira(d.totalHeld)}</td></tr>
          <tr><td style="padding:3px 0;color:#374151;">Active customers</td><td style="text-align:right;font-weight:700;">${d.totalActiveCustomers}</td></tr>
          <tr><td style="padding:3px 0;color:#374151;">Active agents</td><td style="text-align:right;font-weight:700;">${d.totalActiveAgents}</td></tr>
        </table>
      </div>

      <!-- Disbursement pipeline -->
      <div style="margin-top:20px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Withdrawal Requests This Period (${d.disbCount} total)</div>
        <table style="width:100%;font-size:13px;">
          <tr><td style="padding:3px 0;">${icon('clock', '#b45309')}Pending</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.pending || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('eye', '#4338ca')}Reviewed</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.reviewed || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('check', '#15803d')}Approved</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.approved || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('cash', '#011f7b')}Paid</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.paid || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('x', '#b91c1c')}Rejected</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.rejected || 0}</td></tr>
        </table>
      </div>

      <!-- Agent activity — grouped so each agent's work is one scannable
           block instead of everything mixed into one long list -->
      <div style="margin-top:24px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Agent Activity (${d.agentGroups.length} agent${d.agentGroups.length === 1 ? '' : 's'})</div>
        ${agentSectionsHTML}
      </div>

      <!-- Admin actions — suspend/delete/restore/review/etc. Agent logins,
           searches, and collections live inside each agent's own section
           above instead, so nothing appears twice. -->
      <div style="margin-top:24px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Admin Actions</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Time</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Action</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Details</th>
            </tr>
          </thead>
          <tbody>${adminAuditRowsHTML}</tbody>
        </table>
      </div>

      <p style="color:#9ca3af;font-size:11px;margin-top:24px;text-align:center;">
        This is an automated ${REPORT_TYPE} digest generated from live platform data.<br>
        A downloadable PDF copy of this report, including the full admin action logbook, is attached — save it for your records.<br>
        Full raw database backups are stored separately and privately in Cloudflare R2.
      </p>
    </div>
  </div>`;
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────

async function sendEmail(html, pdfBase64) {
  const from = RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';

  // Prefer recipients managed in-app (Settings → Activity Digest Recipients).
  // Falls back to the ADMIN_EMAILS secret only if that list is empty or the
  // table isn't reachable — so this keeps working even before anyone's
  // added a recipient through the UI.
  let to = [];
  try {
    const rows = await fetchRows('report_recipients', 'select=email');
    to = rows.map(r => r.email).filter(Boolean);
  } catch (e) {
    console.error('Could not fetch report_recipients, falling back to secret:', e.message);
  }
  if (!to.length && ADMIN_EMAILS) {
    to = ADMIN_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
  }
  if (!to.length) {
    console.log('No recipients configured (add one in Admin → Settings → Activity Digest Recipients). Skipping send.');
    return;
  }

  const dateStr = NOW.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: `WAG ${PERIOD_LABEL} — ${dateStr}`,
      html,
      attachments: [
        { filename: `WAG-${REPORT_TYPE}-${NOW.toISOString().slice(0, 10)}.pdf`, content: pdfBase64 },
      ],
    }),
  });

  if (!res.ok) {
    console.error('Resend error:', await res.text());
    process.exit(1);
  }
  console.log(`${PERIOD_LABEL} sent successfully to: ${to.join(', ')}`);
}

// ─── RUN ──────────────────────────────────────────────────────────────────

(async () => {
  const data = await gatherReport();
  const html = buildHTML(data);
  const pdfBase64 = await buildPDF(data);
  await sendEmail(html, pdfBase64);
})();
