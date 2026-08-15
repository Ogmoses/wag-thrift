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

// ─── SEND CUMULATIVE LOGBOOK ON DEMAND ────────────────────────────────────
// Powers the "Send Cumulative Logbook Now" button in Admin → Settings, for
// when an admin doesn't want to wait for the scheduled 9 PM WAT run.
// Mirrors .github/scripts/generate-report.js exactly (same WAT date math,
// same slot math, same PDF layout), so a manually-triggered email looks
// identical to a scheduled one — this project's established convention,
// since the cron script runs in GitHub Actions/Node and this Worker runs
// in Cloudflare's own runtime, which can't share a module between them.
//
// Report layout: one block per active customer plan, and inside each
// block, one row per business day of the current month so far — a
// running passbook (Date | Amount | No.), where No. on each day = No.
// from the day before + that day's payment ÷ Rate. Previous (last
// month's closing No.) is shown once above the table, as the starting
// point the first row's No. is computed from. See generate-report.js's
// header comment for the full ASCII layout example.

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

// pdf-lib's built-in font only supports WinAnsi encoding (~Latin-1 range).
// Admin-typed text (customer names, plan names) can contain characters
// outside that — smart quotes, en/em dashes, ellipses. Sanitizes anything
// going into PDF text so it can never crash the send.
function pdfSafe(str) {
  return String(str ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/₦/g, 'NGN ')
    .replace(/[^\x00-\xFF]/g, '?');
}

// ─── WAT (West Africa Time, UTC+1, no DST) DATE HELPERS ───────────────────
// Identical to the copy in .github/scripts/generate-report.js — verified
// against a standalone test suite (test-logic.js) before being placed in
// either file. Keep the two in sync if this ever changes.

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

// Converts a decimal slot count into traditional fraction notation. See
// generate-report.js for the full rationale/edge-case notes.
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
function fmtNairaPDF(n) { return 'NGN ' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }

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

// ─── GATHER: active plans, day-by-day amounts, running cumulative ────────
// See .github/scripts/generate-report.js for the full narrative comments
// on the rollover self-healing behaviour — this is the same logic,
// condensed here to keep this section scannable.

async function gatherLedgerData(env, NOW) {
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
  const insertIgnoreDuplicate = async (table, row) => {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.error(`Failed to insert into ${table}:`, await res.text());
  };

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
  const plans = activePlans.filter(p => custMap[p.customer_id]);

  const dayList = businessDaysInMonth(Y, M0, D);
  const dayKeys = dayList.map(dayKeyOf);
  const dayKeySet = new Set(dayKeys);
  function assignToVisibleDay(txDateKey) {
    if (!dayKeys.length) return null;
    if (dayKeySet.has(txDateKey)) return txDateKey;
    for (const k of dayKeys) if (k >= txDateKey) return k;
    return dayKeys[dayKeys.length - 1];
  }

  if (!plans.length) {
    return { Y, M0, D, YEAR_MONTH, dayList, rows: [], grandTodayNaira: 0 };
  }

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

  const monthStartISO = watMidnightUTC(Y, M0, 1).toISOString();
  const monthTx = await fetchRows(
    'transactions',
    `plan_id=in.(${plans.map(p => p.id).join(',')})&status=eq.confirmed&type=in.(opening,deposit)&created_at=gte.${monthStartISO}&created_at=lte.${NOW.toISOString()}&select=plan_id,amount,created_at&order=created_at.asc`
  );
  const bucket = {};
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
// Condensed today-only summary — the full day-by-day passbook is in the
// attached PDF, which is what's meant to be printed and filed.

function buildLogbookHTML(d) {
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
// Same layout as .github/scripts/generate-report.js's buildPDF() — see
// that file's header comment for the ASCII layout example.

async function buildLogbookPDF(d) {
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
    if (y - blockH < MARGIN && y < PAGE_H - MARGIN - blockH) newPage();

    page.drawRectangle({ x: MARGIN, y: y - BLOCK_HEADER_H, width: gridW, height: BLOCK_HEADER_H, color: NAVY });
    page.drawText(pdfSafe(`${r.customerName} — ${r.planName}`), { x: MARGIN + 8, y: y - 13, size: 10, font: bold, color: rgb(1, 1, 1) });
    const rateLabel = `Rate: ${fmtNairaPDF(r.rate)}`;
    const prevLabel = `Previous: ${r.previousFraction}`;
    const prevX = MARGIN + gridW - 8 - font.widthOfTextAtSize(prevLabel, 8);
    const rateX = prevX - 16 - font.widthOfTextAtSize(rateLabel, 8);
    page.drawText(rateLabel, { x: rateX, y: y - 13, size: 8, font, color: rgb(0.85, 0.88, 0.98) });
    page.drawText(prevLabel, { x: prevX, y: y - 13, size: 8, font: bold, color: rgb(1, 0.729, 0.035) });
    y -= BLOCK_HEADER_H;

    page.drawRectangle({ x: MARGIN, y: y - TABLE_HEADER_H, width: gridW, height: TABLE_HEADER_H, color: rgb(0.9, 0.92, 0.97) });
    page.drawText('DATE', { x: MARGIN + 6, y: y - 11.5, size: 7, font: bold, color: GREY });
    const amtHead = 'AMOUNT';
    page.drawText(amtHead, { x: MARGIN + DATE_W + AMOUNT_W - 6 - bold.widthOfTextAtSize(amtHead, 7), y: y - 11.5, size: 7, font: bold, color: GREY });
    const noHead = 'NO.';
    page.drawText(noHead, { x: MARGIN + DATE_W + AMOUNT_W + NO_W - 6 - bold.widthOfTextAtSize(noHead, 7), y: y - 11.5, size: 7, font: bold, color: GREY });
    y -= TABLE_HEADER_H;

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

  return uint8ToBase64(await pdfDoc.save());
}

async function insertAuditLog(env, row) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
}

async function handleSendDigestNow(request, env) {
  const authCheck = await verifyRequestIsAdmin(request, env);
  if (!authCheck.ok) return json({ error: authCheck.error }, 403);

  // report_type is no longer meaningful (there's only one report now) —
  // accepted and ignored if an older cached frontend still sends it, so
  // this endpoint never breaks for a stale client.
  await request.json().catch(() => ({}));

  const NOW = new Date();
  const data = await gatherLedgerData(env, NOW);
  const html = buildLogbookHTML(data);
  const pdfBase64 = await buildLogbookPDF(data);

  const supaHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const recipRes = await fetch(`${env.SUPABASE_URL}/rest/v1/report_recipients?select=email`, { headers: supaHeaders });
  const recipRows = recipRes.ok ? await recipRes.json() : [];
  const to = recipRows.map(r => r.email).filter(Boolean);
  if (!to.length) {
    return json({ error: 'No recipients configured. Add at least one email under Email Reports first.' }, 400);
  }

  const from = env.RESEND_FROM_EMAIL || 'WAG Enterprises <onboarding@resend.dev>';
  const dateStr = NOW.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: `WAG Cumulative Logbook — ${dateStr}`,
      html,
      attachments: [{ filename: `WAG-Logbook-${data.YEAR_MONTH}-${pad2(data.D)}.pdf`, content: pdfBase64 }],
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.json().catch(() => ({}));
    await insertAuditLog(env, {
      action: 'logbook_report_failed', user_role: 'admin',
      description: `Manual cumulative logbook send failed: ${err.message || 'unknown error'}`,
    });
    return json({ error: err.message || 'Failed to send email' }, 500);
  }

  await insertAuditLog(env, {
    action: 'logbook_report_sent', user_role: 'admin',
    description: `Cumulative logbook sent manually to ${to.length} recipient(s): ${to.join(', ')}`,
  });

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
