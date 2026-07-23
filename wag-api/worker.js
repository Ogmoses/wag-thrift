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
 * Deploy with: wrangler deploy
 */

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
        case '/api/send-verification':
          return await handleSendVerification(request, env);
        case '/api/send-reset-email':
          return await handleSendResetEmail(request, env);
        case '/api/send-digest-now':
          return await handleSendDigestNow(request, env);
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

async function handleSendVerification(request, env) {
  const { toEmail, toName, code } = await request.json();

  if (!toEmail || !code) {
    return json({ error: 'Missing toEmail or code' }, 400);
  }

  // Rate limit: max 3 verification emails per email per 10 minutes
  // Using Cloudflare KV if available, otherwise skip (graceful degradation)
  if (env.RATE_LIMIT_KV) {
    const key = `verify:${toEmail}`;
    const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0');
    if (count >= 3) {
      return json({ error: 'Too many verification attempts. Please wait 10 minutes.' }, 429);
    }
    await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 600 });
  }

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
      subject: 'Your WAG Enterprises verification code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#011f7b;">Wonderful & Able God Enterprises</h2>
          <p>Hi ${toName || 'there'},</p>
          <p>Your account verification code is:</p>
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#011f7b;
                      text-align:center;padding:20px;background:#f0f2f7;
                      border-radius:12px;margin:20px 0;">
            ${code}
          </div>
          <p style="color:#6b7280;font-size:13px;">
            This code expires in 10 minutes.<br>
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    return json({ error: err.message || 'Failed to send email' }, 500);
  }

  return json({ ok: true });
}

// ─── SEND PASSWORD RESET EMAIL ────────────────────────────────────────────────
// Sends the "click here to reset your password" link via Resend.
// Mirrors handleSendVerification above, but for the reset link instead of
// the 6-digit code. Keeps the Resend API key server-side.

async function handleSendResetEmail(request, env) {
  const { toEmail, toName, resetLink } = await request.json();

  if (!toEmail || !resetLink) {
    return json({ error: 'Missing toEmail or resetLink' }, 400);
  }

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
            This link expires in 1 hour.<br>
            If you didn't request this, you can safely ignore this email — your account remains secure.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    return json({ error: err.message || 'Failed to send email' }, 500);
  }

  return json({ ok: true });
}

// ─── SEND ACTIVITY DIGEST ON DEMAND ───────────────────────────────────────────
// Powers the "Send Report Now" button in Admin → Settings, for emergencies
// where an admin doesn't want to wait for the scheduled 7 AM / Monday run.
// Mirrors .github/scripts/generate-report.js exactly, so a manually-triggered
// email looks identical to a scheduled one. Requires the caller to be a real,
// currently logged-in admin — verified against Supabase Auth + the
// administrators table, not just trusted because the request arrived.

async function verifyRequestIsAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, error: 'Not signed in' };

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return { ok: false, error: 'Invalid or expired session' };
  const user = await userRes.json();

  const adminRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/administrators?auth_user_id=eq.${user.id}&status=eq.active&select=id`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const admins = await adminRes.json();
  if (!Array.isArray(admins) || !admins.length) return { ok: false, error: 'Not an admin account' };

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
  const periodLabel = reportType === 'weekly' ? 'Weekly Rollup' : 'Daily Summary';
  const since = periodStart.toISOString();

  const [newCustomers, newAgents, totalActiveCustomers, totalActiveAgents, txRows, disbRows, auditRows, balanceRows] =
    await Promise.all([
      fetchCount('customers', `created_at=gte.${since}`),
      fetchCount('representatives', `created_at=gte.${since}`),
      fetchCount('customers', `status=eq.active`),
      fetchCount('representatives', `status=eq.active`),
      fetchRows('transactions', `created_at=gte.${since}&select=type,amount,customer_name,agent_name,created_at&order=created_at.asc`),
      fetchRows('disbursements', `requested_at=gte.${since}&select=status,amount,customer_name,requested_at`),
      fetchRows('audit_log', `created_at=gte.${since}&select=action,description,amount,created_at&order=created_at.asc`),
      fetchRows('plan_balances', `select=balance`),
    ]);

  const deposits = txRows.filter(t => t.type === 'deposit' || t.type === 'opening');
  const payouts = txRows.filter(t => t.type === 'payout');
  const depositTotal = deposits.reduce((s, t) => s + Number(t.amount), 0);
  const payoutTotal = payouts.reduce((s, t) => s + Number(t.amount), 0);
  const disbByStatus = disbRows.reduce((acc, d) => { acc[d.status] = (acc[d.status] || 0) + 1; return acc; }, {});
  const totalHeld = balanceRows.reduce((s, r) => s + Number(r.balance), 0);

  const auditRowsHTML = auditRows.length
    ? auditRows.map(a => `
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

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;background:#f4f6fb;padding:24px 16px;">
    <div style="background:#011f7b;border-radius:14px 14px 0 0;padding:24px 28px;">
      <div style="color:#FFBA09;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Wonderful &amp; Able God Enterprises</div>
      <div style="color:#fff;font-size:22px;font-weight:800;">${periodLabel} <span style="font-size:12px;font-weight:600;color:#FFBA09;">(sent manually)</span></div>
      <div style="color:#c7d2ea;font-size:13px;margin-top:4px;">${fmtDateTime(periodStart.toISOString())} — ${fmtDateTime(now.toISOString())}</div>
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
          <tr><td style="padding:3px 0;">🕐 Pending</td><td style="text-align:right;font-weight:700;">${disbByStatus.pending || 0}</td></tr>
          <tr><td style="padding:3px 0;">👁️ Reviewed</td><td style="text-align:right;font-weight:700;">${disbByStatus.reviewed || 0}</td></tr>
          <tr><td style="padding:3px 0;">✅ Approved</td><td style="text-align:right;font-weight:700;">${disbByStatus.approved || 0}</td></tr>
          <tr><td style="padding:3px 0;">💸 Paid</td><td style="text-align:right;font-weight:700;">${disbByStatus.paid || 0}</td></tr>
          <tr><td style="padding:3px 0;">❌ Rejected</td><td style="text-align:right;font-weight:700;">${disbByStatus.rejected || 0}</td></tr>
        </table>
      </div>
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
        This ${reportType} digest was sent manually from Admin Settings.<br>
        Full raw database backups are stored separately and privately in Cloudflare R2.
      </p>
    </div>
  </div>`;

  const recipRows = await fetchRows('report_recipients', 'select=email');
  const to = recipRows.map(r => r.email).filter(Boolean);
  if (!to.length) {
    return json({ error: 'No recipients configured. Add at least one email under Email Reports first.' }, 400);
  }

  const from = env.RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: `WAG ${periodLabel} — ${now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      html,
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.json();
    return json({ error: err.message || 'Failed to send email' }, 500);
  }

  return json({ ok: true, sentTo: to });
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

  return { from };
}
