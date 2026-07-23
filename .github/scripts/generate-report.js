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
  ] = await Promise.all([
    fetchCount('customers', `created_at=gte.${since}`),
    fetchCount('representatives', `created_at=gte.${since}`),
    fetchCount('customers', `status=eq.active`),
    fetchCount('representatives', `status=eq.active`),
    fetchRows('transactions', `created_at=gte.${since}&select=type,amount,customer_name,agent_name,created_at&order=created_at.asc`),
    fetchRows('disbursements', `requested_at=gte.${since}&select=status,amount,customer_name,requested_at`),
    fetchRows('audit_log', `created_at=gte.${since}&select=action,description,amount,created_at&order=created_at.asc`),
    fetchRows('plan_balances', `select=balance`),
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

  // Audit log — the transparent "logbook" section, verbatim entries
  const flaggedActions = ['delete', 'flag']; // suspend/restore/delete events

  return {
    newCustomers, newAgents, totalActiveCustomers, totalActiveAgents,
    deposits, payouts, depositTotal, payoutTotal,
    disbByStatus, disbCount: disbRows.length,
    auditRows, totalHeld,
  };
}

// ─── BUILD HTML ───────────────────────────────────────────────────────────

function buildHTML(d) {
  const auditRowsHTML = d.auditRows.length
    ? d.auditRows.map(a => `
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
          <tr><td style="padding:3px 0;">🕐 Pending</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.pending || 0}</td></tr>
          <tr><td style="padding:3px 0;">👁️ Reviewed</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.reviewed || 0}</td></tr>
          <tr><td style="padding:3px 0;">✅ Approved</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.approved || 0}</td></tr>
          <tr><td style="padding:3px 0;">💸 Paid</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.paid || 0}</td></tr>
          <tr><td style="padding:3px 0;">❌ Rejected</td><td style="text-align:right;font-weight:700;">${d.disbByStatus.rejected || 0}</td></tr>
        </table>
      </div>

      <!-- Audit logbook — the transparency section -->
      <div style="margin-top:24px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Admin Action Logbook</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Time</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Action</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Details</th>
            </tr>
          </thead>
          <tbody>${auditRowsHTML}</tbody>
        </table>
      </div>

      <p style="color:#9ca3af;font-size:11px;margin-top:24px;text-align:center;">
        This is an automated ${REPORT_TYPE} digest generated from live platform data.<br>
        Full raw database backups are stored separately and privately in Cloudflare R2.
      </p>
    </div>
  </div>`;
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────

async function sendEmail(html) {
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

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: `WAG ${PERIOD_LABEL} — ${NOW.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      html,
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
  await sendEmail(html);
})();
