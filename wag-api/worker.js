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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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
