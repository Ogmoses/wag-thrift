/**
 * WAG Thrift — Cloudflare Worker API
 *
 * Handles operations that require server-side execution:
 * - Password reset (needs service role key to update Auth passwords)
 * - Future: withdrawal approval, rate limiting, IP-based fraud detection
 *
 * Environment variables (set in Cloudflare Workers dashboard):
 *   SUPABASE_URL           — your Supabase project URL
 *   SUPABASE_SERVICE_KEY   — service role key (NEVER the anon key)
 *
 * Deploy with: git push (auto-deployed via Cloudflare Workers Builds)
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/api/reset-password':
          return await handleResetPassword(request, env);
        case '/api/request-password-reset':
          return await handleRequestPasswordReset(request, env);
        case '/api/send-digest-now':
          return await handleSendDigestNow(request, env);
        case '/api/delete-auth-account':
          return await handleDeleteAuthAccount(request, env);
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (e) {
      console.error('Worker error:', e);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};

// ─── PASSWORD RESET ───────────────────────────────────────────────────────────
// Completes a password reset using our own token table.
// Uses the SERVICE ROLE key (server-side only) to update the Auth user's
// password via Supabase Admin API — this can't safely be done from the browser.

async function handleResetPassword(request, env) {
  const { token, newPassword } = await request.json();

  if (!token || !newPassword) {
    return json({ error: 'Missing token or newPassword' }, 400);
  }
  if (newPassword.length < 6) {
    return json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const supa = supabaseAdmin(env);

  // 1. Verify token is valid, unused, and not expired
  const { data: tokenRow, error: tokenErr } = await supa
    .from('password_resets')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (tokenErr || !tokenRow) {
    return json({ error: 'Invalid or already-used reset link' }, 400);
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return json({ error: 'This reset link has expired. Please request a new one.' }, 400);
  }

  // 2. Find the account linked to this contact email
  const [{ data: cust }, { data: rep }] = await Promise.all([
    supa.from('customers').select('auth_user_id').eq('email', tokenRow.email).single(),
    supa.from('representatives').select('auth_user_id').eq('email', tokenRow.email).single(),
  ]);

  const authUserId = cust?.auth_user_id || rep?.auth_user_id;
  if (!authUserId) {
    return json({ error: 'Account not found for this email' }, 400);
  }

  // 3. Update the password via the Admin API (privileged — requires service key)
  const updateRes = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users/${authUserId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({ password: newPassword }),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    return json({ error: err.message || 'Failed to update password' }, 500);
  }

  // 4. Mark token used — can't be replayed
  await supa.from('password_resets').update({ used: true }).eq('token', token);

  return json({ ok: true });
}

// ─── SEND VERIFICATION EMAIL (registration codes) ────────────────────────────
// Sends the 6-digit registration verification code via Resend.
// Keeps the Resend API key server-side — never exposed to the browser.

// ─── REQUEST PASSWORD RESET (generates token + sends the email, both server-side) ──
// Previously this was two separate steps: the browser called
// request_password_reset() directly (getting the raw token back into
// client-side JS), built the reset link itself, then POSTed that
// client-built link to a separate /api/send-reset-email endpoint that
// trusted it completely — no verification the link was ever real. That
// meant anyone could POST { toEmail: <victim>, resetLink: <anything> }
// directly to that endpoint and this domain's Resend-verified sender
// would send a legitimate-looking "reset your password" email with a
// phishing link of the attacker's choosing to any address they wanted.
// Consolidating this into one server-side step closes both problems:
// the token never reaches the browser, and the link is always the one
// the RPC actually generated — nothing here trusts caller-supplied
// content beyond the target email address itself.
async function handleRequestPasswordReset(request, env) {
  const { email } = await request.json();
  if (!email) return json({ error: 'Missing email' }, 400);

  const supa = supabaseAdmin(env);

  // request_password_reset() already handles existence-checking,
  // anti-enumeration, and rate limiting (3/hour per email) entirely
  // server-side in SQL — this just calls it with the service role
  // instead of the browser's session.
  const { data: result } = await supa.rpc('request_password_reset', { p_email: email });

  if (result?.exists && result?.token) {
    const [{ data: cust }, { data: rep }] = await Promise.all([
      supa.from('customers').select('first_name').eq('email', email).single(),
      supa.from('representatives').select('first_name').eq('email', email).single(),
    ]);
    const toName = cust?.first_name || rep?.first_name || 'there';
    const resetLink = `${env.SITE_URL || 'https://wag-thrift.pages.dev'}/login.html?reset=${result.token}`;
    await sendResetEmailViaResend(env, email, toName, resetLink);
  }

  // Always the same response whether or not the account exists, or
  // whether an email actually got sent — matches the RPC's own
  // anti-enumeration design. Never reveal which emails are registered.
  return json({ ok: true });
}

async function sendResetEmailViaResend(env, toEmail, toName, resetLink) {
  const from = env.RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: 'Reset your WAG Enterprises password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#011f7b;">Wonderful & Able God Enterprises</h2>
          <p>Hi ${toName || 'there'},</p>
          <p>We received a request to reset the password for your account. Click the button below to create a new password:</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${resetLink}" style="display:inline-block;background:#011f7b;color:#fff;
                      text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;">
              Reset Password
            </a>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            This link expires in 15 minutes.<br>
            If you didn't request this, you can safely ignore this email — your account remains secure.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Resend error sending reset email:', err.message || 'unknown');
  }
}

// ─── SEND ACTIVITY DIGEST ON DEMAND ───────────────────────────────────────────
// Powers the "Send Report Now" button in Admin → Settings, for emergencies
// where an admin doesn't want to wait for the scheduled 7 AM / Monday run.
// Mirrors .github/scripts/generate-report.js exactly, so a manually-triggered
// email looks identical to a scheduled one. Requires the caller to be a real,
// currently logged-in admin — verified against Supabase Auth + the
// administrators table, not just trusted because the request arrived.

// Converts a Uint8Array to base64 without Node's Buffer (not available in
// Workers by default). Chunked to avoid call-stack limits on large PDFs.
function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Same PDF layout as .github/scripts/generate-report.js, so a manually
// sent report matches a scheduled one. pdf-lib's built-in font can't
// encode the ₦ symbol, so amounts use "NGN 1,234" here — the HTML email
// keeps the real ₦ symbol since phones render that fine.
// pdf-lib's built-in font only supports WinAnsi encoding (~Latin-1 range).
// Admin-typed text can contain characters outside that — smart quotes,
// en/em dashes, ellipses — especially across a full week of entries.
// Sanitizes anything going into PDF text so it can never crash the send.
function pdfSafe(str) {
  return String(str ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/₦/g, 'NGN ')
    .replace(/[^\x00-\xFF]/g, '?');
}

async function buildDigestPDF(reportType, periodLabel, reportRef, periodStart, now, d) {
  const fmtNairaPDF = (n) => 'NGN ' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  const fmtDT = (iso) => new Date(iso).toLocaleString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.004, 0.122, 0.482);
  const GREY = rgb(0.42, 0.45, 0.5);
  const BLACK = rgb(0.07, 0.09, 0.14);
  const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const newPageIfNeeded = (need) => { if (y - need < MARGIN) { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; } };
  const text = (str, x, size, f, color) => page.drawText(String(str), { x, y, size, font: f || font, color: color || BLACK });
  const line = (h) => { y -= h; };

  text('WONDERFUL & ABLE GOD ENTERPRISES', MARGIN, 10, bold, rgb(0.7, 0.5, 0));
  const confLabel = 'CONFIDENTIAL';
  text(confLabel, PAGE_W - MARGIN - bold.widthOfTextAtSize(confLabel, 8), 8, bold, GREY);
  line(18);
  text(periodLabel, MARGIN, 20, bold, NAVY);
  line(16);
  text(`${fmtDT(periodStart.toISOString())}  -  ${fmtDT(now.toISOString())}`, MARGIN, 10, font, GREY);
  line(13);
  text(`Ref: ${reportRef}`, MARGIN, 9, font, GREY);
  line(28);

  text('CASH POSITION SUMMARY', MARGIN, 11, bold, NAVY);
  line(18);
  [
    ['New customers', String(d.newCustomers)],
    ['New agents', String(d.newAgents)],
    ['Deposits collected', `${fmtNairaPDF(d.depositTotal)} (${d.deposits.length} txn)`],
    ['Withdrawals paid', `${fmtNairaPDF(d.payoutTotal)} (${d.payouts.length} txn)`],
    ['Net cash movement', fmtNairaPDF(d.depositTotal - d.payoutTotal)],
    ['Total funds held across all plans', fmtNairaPDF(d.totalHeld)],
    ['Active customers', String(d.totalActiveCustomers)],
    ['Active agents', String(d.totalActiveAgents)],
  ].forEach(([label, value]) => {
    newPageIfNeeded(16);
    text(label, MARGIN, 10, font, BLACK);
    text(value, PAGE_W - MARGIN - bold.widthOfTextAtSize(value, 10), 10, bold, BLACK);
    line(16);
  });
  line(10);

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

  newPageIfNeeded(60);
  text(`AGENT COLLECTIONS & DISBURSEMENTS (${d.agentGroups.length} agent${d.agentGroups.length === 1 ? '' : 's'})`, MARGIN, 11, bold, NAVY);
  line(20);

  if (!d.agentGroups.length) {
    text('No agent activity this period.', MARGIN, 10, font, GREY);
    line(20);
  } else {
    d.agentGroups.forEach(g => {
      newPageIfNeeded(50);
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
          text(fmtDT(t.created_at), gColTime, 8, font, GREY);
          text(pdfSafe(t.ref || '-'), gColRef, 8, font, BLACK);
          text(pdfSafe(t.customer_name || 'Customer'), gColCust, 8, font, BLACK);
          text(amtStr, gColAmt - bold.widthOfTextAtSize(amtStr, 8), 8, bold, isIn ? rgb(0.08, 0.5, 0.18) : rgb(0.73, 0.11, 0.11));
          line(13);
        });
      }
      line(10);
    });
  }
  line(10);

  newPageIfNeeded(30);
  text('This report covers deposits and withdrawals only. The full admin', MARGIN, 8.5, font, GREY);
  line(11);
  text('audit trail is available in-app under Admin -> Settings -> Audit Log.', MARGIN, 8.5, font, GREY);
  line(11);

  const pdfBytes = await pdfDoc.save();
  return uint8ToBase64(pdfBytes);
}

async function verifyRequestIsAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, error: 'Not signed in' };

  // Delegates entirely to is_admin() — the exact same function every SQL
  // RPC in this project uses — instead of a separately-maintained REST
  // query that re-implemented its logic. That old version had already
  // silently drifted from it: is_admin() requires MFA (aal2) for any
  // admin who has enrolled it; this Worker-side check never enforced
  // that. Calling the real function means the two can no longer disagree
  // by construction — there's only one place this logic lives now.
  // The user's own token (not the service key) is passed as
  // Authorization here specifically so auth.uid() inside is_admin()
  // resolves to the requesting user, not nobody.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (res.status === 401) return { ok: false, error: 'Invalid or expired session' };
  if (!res.ok) return { ok: false, error: 'Could not verify admin status' };

  const isAdmin = await res.json();
  if (isAdmin !== true) return { ok: false, error: 'Not an admin account' };

  return { ok: true };
}

async function handleSendDigestNow(request, env) {
  const authCheck = await verifyRequestIsAdmin(request, env);
  if (!authCheck.ok) return json({ error: authCheck.error }, 403);

  const { report_type } = await request.json();
  const reportType = report_type === 'weekly' ? 'weekly' : 'daily';

  const supaHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const fetchRows = async (table, params) => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: supaHeaders });
    if (!res.ok) { console.error(`Failed to fetch ${table}:`, await res.text()); return []; }
    return res.json();
  };
  const fetchCount = async (table, params) => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${params}`, {
      headers: { ...supaHeaders, Prefer: 'count=exact', Range: '0-0' },
    });
    const range = res.headers.get('content-range');
    return range ? parseInt(range.split('/')[1] || '0', 10) : 0;
  };
  const fmtNaira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const now = new Date();
  const periodHours = reportType === 'weekly' ? 24 * 7 : 24;
  const periodStart = new Date(now.getTime() - periodHours * 60 * 60 * 1000);
  const periodLabel = reportType === 'weekly' ? 'Weekly Cash Report' : 'Daily Cash Report';
  const since = periodStart.toISOString();
  const reportRef = `WAG-${reportType.toUpperCase()}-${now.toISOString().slice(0, 10)}`;

  const [newCustomers, newAgents, totalActiveCustomers, totalActiveAgents, txRows, disbRows, balanceRows, agentRows] =
    await Promise.all([
      fetchCount('customers', `created_at=gte.${since}`),
      fetchCount('representatives', `created_at=gte.${since}`),
      fetchCount('customers', `status=eq.active`),
      fetchCount('representatives', `status=eq.active`),
      fetchRows('transactions', `created_at=gte.${since}&select=ref,type,amount,customer_name,agent_name,agent_id,created_at&order=created_at.asc`),
      fetchRows('disbursements', `requested_at=gte.${since}&select=status,amount,customer_name,requested_at`),
      fetchRows('plan_balances', `select=balance`),
      fetchRows('representatives', `select=id,first_name,last_name,rep_id`),
    ]);

  const deposits = txRows.filter(t => t.type === 'deposit' || t.type === 'opening');
  const payouts = txRows.filter(t => t.type === 'payout');
  const depositTotal = deposits.reduce((s, t) => s + Number(t.amount), 0);
  const payoutTotal = payouts.reduce((s, t) => s + Number(t.amount), 0);
  const disbByStatus = disbRows.reduce((acc, d) => { acc[d.status] = (acc[d.status] || 0) + 1; return acc; }, {});
  const totalHeld = balanceRows.reduce((s, r) => s + Number(r.balance), 0);

  // Groups this period's deposit/payout transactions by the agent who
  // handled them, so an admin can see one agent's whole day as one block.
  // Fix: this report is a Cash Report — deposits and payouts only, for
  // agents and customers. It used to also carry a full admin-actions
  // audit trail (suspends, deletes, flags, etc.) alongside a per-agent
  // "other activity" line pulled from audit_log; both are gone now. That
  // internal audit trail still exists in full in Admin → Settings → Audit
  // Log — it just doesn't belong in a report that gets emailed out.
  const agentMap = {};
  (agentRows || []).forEach(a => { agentMap[a.id] = a; });
  const agentGroupsObj = {};
  const getAgentGroup = (agentId, fallbackName) => {
    if (!agentGroupsObj[agentId]) {
      const a = agentMap[agentId];
      agentGroupsObj[agentId] = { agentId, agentName: a ? `${a.first_name} ${a.last_name}` : (fallbackName || 'Unknown Agent'), repId: a?.rep_id || null, transactions: [], totalCollected: 0 };
    }
    return agentGroupsObj[agentId];
  };
  txRows.forEach(t => {
    if (!t.agent_id) return;
    const g = getAgentGroup(t.agent_id, t.agent_name);
    g.transactions.push(t);
    if (t.type === 'deposit' || t.type === 'opening') g.totalCollected += Number(t.amount);
  });
  const agentGroups = Object.values(agentGroupsObj).sort((a, b) => b.totalCollected - a.totalCollected);

  const icon = (name, color) => {
    const paths = {
      clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
      eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
      check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
      x: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    };
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;margin-right:6px;">${paths[name]}</svg>`;
  };

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#f4f6fb;padding:24px 16px;">
    <div style="background:#011f7b;border-radius:14px 14px 0 0;padding:24px 28px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="color:#FFBA09;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Wonderful &amp; Able God Enterprises</div>
        <div style="color:#8a97c2;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid #2a3a7a;border-radius:4px;padding:2px 7px;">Confidential</div>
      </div>
      <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px;">${periodLabel}</div>
      <div style="color:#c7d2ea;font-size:13px;margin-top:4px;">${fmtDateTime(periodStart.toISOString())} — ${fmtDateTime(now.toISOString())}</div>
      <div style="color:#8a97c2;font-size:11px;margin-top:2px;">Ref: ${reportRef}</div>
    </div>
    <div style="background:#fff;padding:24px 28px;">
      <table style="width:100%;border-collapse:separate;border-spacing:8px 8px;margin:-8px;">
        <tr>
          <td style="width:50%;background:#f0f4ff;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">New Customers</div>
            <div style="font-size:22px;font-weight:800;color:#011f7b;">${newCustomers}</div>
          </td>
          <td style="width:50%;background:#f0f4ff;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;">New Agents</div>
            <div style="font-size:22px;font-weight:800;color:#011f7b;">${newAgents}</div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff8e8;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:700;">Deposits Collected</div>
            <div style="font-size:20px;font-weight:800;color:#111827;">${fmtNaira(depositTotal)}</div>
            <div style="font-size:11px;color:#6b7280;">${deposits.length} transaction(s)</div>
          </td>
          <td style="background:#fff8e8;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:700;">Withdrawals Paid</div>
            <div style="font-size:20px;font-weight:800;color:#111827;">${fmtNaira(payoutTotal)}</div>
            <div style="font-size:11px;color:#6b7280;">${payouts.length} transaction(s)</div>
          </td>
        </tr>
      </table>
      <div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Platform Snapshot (as of now)</div>
        <table style="width:100%;font-size:13px;">
          <tr><td style="padding:3px 0;color:#374151;">Total funds held across all plans</td><td style="text-align:right;font-weight:700;color:#011f7b;">${fmtNaira(totalHeld)}</td></tr>
          <tr><td style="padding:3px 0;color:#374151;">Active customers</td><td style="text-align:right;font-weight:700;">${totalActiveCustomers}</td></tr>
          <tr><td style="padding:3px 0;color:#374151;">Active agents</td><td style="text-align:right;font-weight:700;">${totalActiveAgents}</td></tr>
        </table>
      </div>
      <div style="margin-top:20px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Withdrawal Requests This Period (${disbRows.length} total)</div>
        <table style="width:100%;font-size:13px;">
          <tr><td style="padding:3px 0;">${icon('clock', '#b45309')}Pending</td><td style="text-align:right;font-weight:700;">${disbByStatus.pending || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('eye', '#4338ca')}Reviewed</td><td style="text-align:right;font-weight:700;">${disbByStatus.reviewed || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('check', '#15803d')}Approved</td><td style="text-align:right;font-weight:700;">${disbByStatus.approved || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('cash', '#011f7b')}Paid</td><td style="text-align:right;font-weight:700;">${disbByStatus.paid || 0}</td></tr>
          <tr><td style="padding:3px 0;">${icon('x', '#b91c1c')}Rejected</td><td style="text-align:right;font-weight:700;">${disbByStatus.rejected || 0}</td></tr>
        </table>
      </div>
      <div style="margin-top:24px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Agent Activity (${agentGroups.length} agent${agentGroups.length === 1 ? '' : 's'})</div>
        ${
          agentGroups.length
            ? agentGroups.map(g => {
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
                </div>`;
              }).join('')
            : `<div style="padding:14px;text-align:center;color:#9ca3af;font-size:13px;border:1px solid #e5e7eb;border-radius:10px;">No agent activity this period.</div>`
        }
      </div>
      <p style="color:#9ca3af;font-size:11px;margin-top:24px;text-align:center;">
        A downloadable PDF copy of this ${reportType} Cash Report is attached for your records.<br>
        This report covers deposits and withdrawals only. The full admin audit trail stays in-app under Admin → Settings → Audit Log.<br>
        Full raw database backups are stored separately and privately in Cloudflare R2.
      </p>
    </div>
  </div>`;

  const recipRows = await fetchRows('report_recipients', 'select=email');
  const to = recipRows.map(r => r.email).filter(Boolean);
  if (!to.length) {
    return json({ error: 'No recipients configured. Add at least one email under Email Reports first.' }, 400);
  }

  const pdfBase64 = await buildDigestPDF(reportType, periodLabel, reportRef, periodStart, now, {
    newCustomers, newAgents, totalActiveCustomers, totalActiveAgents,
    deposits, payouts, depositTotal, payoutTotal,
    disbByStatus, disbCount: disbRows.length, agentGroups, totalHeld,
  });

  const from = env.RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: `WAG ${periodLabel} — ${now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      html,
      attachments: [
        { filename: `WAG-${reportType}-${now.toISOString().slice(0, 10)}.pdf`, content: pdfBase64 },
      ],
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.json();
    return json({ error: err.message || 'Failed to send email' }, 500);
  }

  return json({ ok: true, sentTo: to });
}

// ─── RETIRE AUTH ACCOUNT (after a permanent delete) ───────────────────────────
// Admin's deleteCustomer()/deleteAgent() (js/admin.js) only ever anonymized
// the customers/representatives PROFILE ROW — it never touched the
// underlying Supabase Auth account, which can't be done from the browser at
// all (requires the service role key). That left an orphaned Auth user
// behind forever, still holding the deterministic internal email built from
// that phone number (customer_internal_email()/rep_internal_email()) — so
// re-registering ANYONE with that same phone number later would always hit
// Supabase's own "User already registered" error on signUp(), with no
// visible connection to the account that was supposedly deleted.
//
// This renames the account rather than hard-deleting it. An earlier version
// tried a real DELETE — an information_schema query had confirmed nothing
// holds a foreign key directly against auth.users, so that looked safe. In
// practice it wasn't: deleting the Auth user surfaced a live error
// ("...violates foreign key constraint transactions_customer_id_fkey..."),
// which means something in this Supabase project — almost certainly a
// TRIGGER on auth.users, not a constraint — cascades an Auth-user delete
// into also hard-deleting the linked customers/representatives row. That
// row deliberately needs to survive (anonymized) so transaction history
// keeps working, so a real delete here is fundamentally incompatible with
// this schema. Renaming sidesteps the trigger entirely: nothing gets
// deleted, so nothing cascades, while still freeing the phone number for
// reuse by moving the login email out of the way.
async function handleDeleteAuthAccount(request, env) {
  const authCheck = await verifyRequestIsAdmin(request, env);
  if (!authCheck.ok) return json({ error: authCheck.error }, 403);

  const { authUserId } = await request.json();
  if (!authUserId) return json({ error: 'Missing authUserId' }, 400);

  const retiredEmail = `retired-${authUserId}@wagthrift.retired`;
  const randomPassword = crypto.randomUUID();

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ email: retiredEmail, password: randomPassword, email_confirm: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || 'Failed to retire the Auth account' }, 500);
  }

  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function supabaseAdmin(env) {
  // Minimal Supabase client using fetch — no npm needed in Workers
  const headers = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  const base = `${env.SUPABASE_URL}/rest/v1`;

  const from = (table) => ({
    select: (cols = '*') => ({
      eq: (col, val) => ({
        single: async () => {
          const res = await fetch(
            `${base}/${table}?select=${cols}&${col}=eq.${encodeURIComponent(val)}&limit=1`,
            { headers: { ...headers, 'Prefer': 'return=representation' } }
          );
          const rows = await res.json();
          return { data: Array.isArray(rows) ? rows[0] || null : null, error: res.ok ? null : rows };
        },
        _buildUrl: () => `${base}/${table}?select=${cols}&${col}=eq.${encodeURIComponent(val)}`,
      }),
    }),
    update: (patch) => ({
      eq: async (col, val) => {
        const res = await fetch(
          `${base}/${table}?${col}=eq.${encodeURIComponent(val)}`,
          { method: 'PATCH', headers, body: JSON.stringify(patch) }
        );
        return { error: res.ok ? null : await res.json() };
      },
    }),
  });

  return {
    from,
    rpc: async (fnName, params = {}) => {
      const res = await fetch(`${base}/rpc/${fnName}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => null);
      return { data, error: res.ok ? null : data };
    },
  };
}
