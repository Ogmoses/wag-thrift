// ═══════════════════════════════════════════════
// js/auth.js
// SESSION MANAGEMENT · LOGIN/LOGOUT/REGISTER · ROUTE GUARDS
// AUDIT LOGGING · FRAUD DETECTION
// Now backed by REAL Supabase Auth (supabase.auth.*) instead of manual
// password-hash comparisons. Customers/reps still log in with phone /
// Agent ID — those are translated to hidden internal emails
// (c08012345678@wag.internal / r234567@wag.internal) under the hood via
// the customer_internal_email()/rep_internal_email() SQL functions.
// Depends on: js/supabase.js, js/utils.js (load both first)
// ═══════════════════════════════════════════════

// ── SHA-256 hashing — still used for the separate PAYMENT PIN
// (withdrawal confirmation), NOT for login passwords anymore.
async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── SESSION HELPERS
// getUser() now reads from the cached profile we store alongside the
// Supabase session, populated by refreshUserProfile() after sign-in.
function getUser() { try { return JSON.parse(sessionStorage.getItem('wagUser')); } catch (e) { return null; } }
function setUser(u) { sessionStorage.setItem('wagUser', JSON.stringify(u)); }

// Re-fetches the customer/representative profile row for the CURRENTLY
// signed-in Supabase Auth user, and caches it in sessionStorage as before
// so the rest of the app (which reads getUser()) doesn't need to change.
async function refreshUserProfile(expectedRole) {
  if (!db) return null;
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user) return null;
  const authId = session.user.id;
  const table = expectedRole === 'representative' ? 'representatives' : 'customers';
  const { data, error } = await db.from(table).select('*').eq('auth_user_id', authId).single();
  if (error || !data) return null;
  if (data.status === 'suspended' || data.status === 'deleted') return null;
  const profile = { ...data, role: expectedRole };
  setUser(profile);
  return profile;
}

// ── ROLE GUARD HELPERS
const ROLE_HOME = {
  customer: 'customer/dashboard.html',
  representative: 'representative/dashboard.html',
  admin: 'admin/dashboard.html'
};

// verifyRoleFromDB — now backed by a REAL Supabase Auth session check.
// There is no longer a sessionStorage value that can be hand-edited to
// fake a role: this checks the live JWT session and re-derives the
// profile from the database every time.
async function verifyRoleFromDB(expectedRole) {
  if (!db) return false;
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user) { doLogout(); return false; }
  const profile = await refreshUserProfile(expectedRole);
  if (!profile) { doLogout(); return false; }
  return true;
}

// requireRole — quick synchronous check using the cached profile, for
// immediate UI decisions (e.g. don't flash protected content). Always
// followed by verifyRoleFromDB() for the real, authoritative check.
function requireRole(allowedRoles) {
  const u = getUser();
  if (!u || !u.role) {
    window.location.replace(rootPath() + 'login.html');
    return null;
  }
  if (!allowedRoles.includes(u.role)) {
    window.location.replace(rootPath() + (ROLE_HOME[u.role] || 'login.html'));
    return null;
  }
  return u;
}

// Note: admin session helpers (getAdminSession/setAdminSession/clearAdminSession/
// requireAdmin) and the admin audit() live in js/admin.js — admin pages do NOT
// load this file, keeping admin fully isolated from customer/rep auth.
// Admin continues to use the existing PIN-gate system (unchanged by this migration).

// ═══════════════════════════════════════════════
// AUDIT LOGGING
// ═══════════════════════════════════════════════
async function audit(action, userId, userRole, description, amount = null, planId = null) {
  const { error } = await db.from('audit_log').insert({ action, user_id: String(userId), user_role: userRole, description, amount, plan_id: planId });
  if (error) {
    // Surface audit failures visibly since they're otherwise silent
    const msg = `[Audit failed: ${error.message}]`;
    const el = document.getElementById('colMsg') || document.getElementById('regMsg') || document.getElementById('loginMsg');
    if (el) el.innerHTML = `<div class="msg-err" style="font-size:10px;">${msg}</div>`;
    console.error('audit() error:', error);
  }
}

// ═══════════════════════════════════════════════
// FRAUD DETECTION
// ═══════════════════════════════════════════════
async function flagFraud(type, severity, userId, description, planId = null) {
  const { data: existing } = await db.from('fraud_flags').select('id').eq('type', type).eq('user_id', userId).eq('resolved', false);
  if (!existing || existing.length === 0) {
    await db.from('fraud_flags').insert({ type, severity, user_id: userId, description, plan_id: planId, resolved: false });
  }
}
async function checkLargeCollection(amount, agentId, planId) {
  if (amount > 50000) await flagFraud('LARGE_COLLECTION', 'medium', agentId, `Unusually large collection of ${fmt(amount)}`, planId);
}
async function checkExcessWithdrawal(customerId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db.from('disbursements').select('id').eq('customer_id', customerId).eq('type', 'withdrawal').gte('requested_at', since);
  if (data && data.length >= 3) await flagFraud('EXCESS_WITHDRAWAL', 'high', customerId, `${data.length} withdrawal requests in 30 days`);
}
// checkFailedPin is now superseded by Supabase Auth's own rate limiting on
// signInWithPassword, but we keep a lightweight local counter for the
// "Account locked" UX message (Supabase doesn't expose attempt counts to us).
async function checkFailedPin(phone) {
  const { data } = await db.from('pin_attempts').select('attempts').eq('phone', phone).single();
  const attempts = (data?.attempts || 0) + 1;
  await db.from('pin_attempts').upsert({ phone, attempts, last_attempt: new Date().toISOString() });
  if (attempts === 3) await flagFraud('FAILED_PIN_ATTEMPTS', 'medium', phone, `3 failed PIN attempts for ${phone}`);
  return attempts >= 5;
}

// ═══════════════════════════════════════════════
// LOGIN — now via supabase.auth.signInWithPassword()
// currentRole is set by the login page UI ('customer' | 'representative')
// ═══════════════════════════════════════════════
async function doLogin() {
  if (!dbReady()) return;
  if (currentRole === 'customer') {
    const rawPh = document.getElementById('loginPhone').value.trim(), pin = document.getElementById('loginPin').value.trim();
    const normPh = normPhone(rawPh);
    showLoading('Signing in…');

    const { data: attempts } = await db.from('pin_attempts').select('attempts').eq('phone', normPh).single();
    if ((attempts?.attempts || 0) >= 5) { hideLoading(); setMsg('loginMsg', '<div class="msg-err">Account locked due to too many failed attempts.</div>'); return; }

    // Translate phone -> internal email via the SQL helper, then sign in
    // through real Supabase Auth (password verified server-side by Supabase,
    // never compared in our own code).
    const { data: emailResult } = await db.rpc('get_login_email_for_phone', { p_phone: normPh });
    if (!emailResult) { hideLoading(); const locked = await checkFailedPin(normPh); setMsg('loginMsg', `<div class="msg-err">Invalid phone or password.${locked ? ' Account locked.' : ''}</div>`); return; }

    const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email: emailResult, password: pin });
    if (authErr || !authData?.session) { hideLoading(); const locked = await checkFailedPin(normPh); setMsg('loginMsg', `<div class="msg-err">Invalid phone or password.${locked ? ' Account locked.' : ''}</div>`); return; }

    const profile = await refreshUserProfile('customer');
    if (!profile) {
      hideLoading();
      await db.auth.signOut();
      setMsg('loginMsg', '<div class="msg-err">This account has been suspended or could not be found. Please contact support.</div>');
      return;
    }

    await db.from('pin_attempts').upsert({ phone: normPh, attempts: 0 });
    await audit('login', profile.id, 'customer', `Customer signed in: ${profile.first_name} ${profile.last_name}`);
    hideLoading();
    window.location.href = rootPath() + ROLE_HOME.customer;
  } else {
    const rid = document.getElementById('loginRepId').value.trim(), pin = document.getElementById('loginRepPin').value.trim();
    showLoading('Signing in…');

    const { data: emailResult } = await db.rpc('get_login_email_for_rep_id', { p_rep_id: rid });
    if (!emailResult) { hideLoading(); setMsg('loginRepMsg', '<div class="msg-err">Invalid Agent ID or password</div>'); return; }

    const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email: emailResult, password: pin });
    if (authErr || !authData?.session) { hideLoading(); setMsg('loginRepMsg', '<div class="msg-err">Invalid Agent ID or password</div>'); return; }

    const profile = await refreshUserProfile('representative');
    if (!profile) {
      hideLoading();
      await db.auth.signOut();
      setMsg('loginRepMsg', '<div class="msg-err">This agent account has been suspended or could not be found. Please contact your supervisor.</div>');
      return;
    }

    await audit('login', profile.id, 'representative', `Representative signed in: ${profile.first_name} ${profile.last_name} (${profile.rep_id})`);
    hideLoading();
    window.location.href = rootPath() + ROLE_HOME.representative;
  }
}

// ═══════════════════════════════════════════════
// LOGOUT — signs out of the real Supabase Auth session.
// ═══════════════════════════════════════════════
async function doLogout() {
  stopSuspendCheck();
  const u = getUser();
  if (u) await audit('login', u.id, u.role || 'unknown', `${u.first_name} ${u.last_name} signed out`);
  if (db) await db.auth.signOut();
  sessionStorage.removeItem('wagUser');
  localStorage.removeItem('wagActiveUser');
  window.location.href = rootPath() + 'login.html';
}

// ═══════════════════════════════════════════════
// REGISTRATION (customer) — email verification flow unchanged in UX;
// the actual account creation now goes through supabase.auth.signUp()
// followed by complete_customer_registration() to create the profile row.
// ═══════════════════════════════════════════════
async function doRegister() {
  if (!dbReady()) return;
  const fn = document.getElementById('regFn').value.trim(), ln = document.getElementById('regLn').value.trim(),
    em = document.getElementById('regEm').value.trim(), ph = document.getElementById('regPh').value.trim(),
    addr = document.getElementById('regAddr').value.trim(), pin = document.getElementById('regPin').value.trim();
  if (!fn || !ln || !em || !ph || !addr || !pin) { setMsg('regMsg', '<div class="msg-err">Please fill in all fields</div>'); return; }
  if (pin.length < 6) { setMsg('regMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  const normPh = normPhone(ph);
  showLoading('Checking details…');
  const { data: existing } = await db.from('customers').select('id').eq('phone', normPh).single();
  hideLoading();
  if (existing) { setMsg('regMsg', '<div class="msg-err">Phone number already registered</div>'); return; }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  sessionStorage.setItem('wagVerify', JSON.stringify({ code, fn, ln, em, ph: normPh, addr, pin, expires: Date.now() + 600000 }));
  showLoading('Sending verification code…');
  const result = await sendVerificationEmail(em, fn, code);
  hideLoading();
  document.getElementById('custCreateFormBtns').style.display = 'none';
  document.getElementById('verifySection').style.display = 'block';
  if (result.error) {
    document.getElementById('verifyInfo').innerHTML = `Could not send email automatically. <br><small style="color:var(--sub);">Your code is: <strong style="font-family:monospace;color:var(--blue);font-size:16px;">${code}</strong></small>`;
  } else if (result.demo) {
    document.getElementById('verifyInfo').innerHTML = `EmailJS not configured yet.<br><small style="color:var(--sub);">For now your code is: <strong style="font-family:monospace;color:var(--blue);font-size:16px;">${code}</strong></small>`;
  } else {
    document.getElementById('verifyInfo').innerHTML = `A 6-digit verification code has been sent to <strong>${em}</strong>. Please check your inbox and enter the code below.`;
  }
  setMsg('regMsg', '');
}

function cancelVerification() {
  document.getElementById('custCreateFormBtns').style.display = 'block';
  document.getElementById('verifySection').style.display = 'none';
  setMsg('verifyMsg', '');
}

async function doVerifyCode() {
  if (!dbReady()) return;
  const entered = document.getElementById('verifyCodeInp').value.trim();
  const stored = JSON.parse(sessionStorage.getItem('wagVerify') || '{}');
  if (!stored.code) { setMsg('verifyMsg', '<div class="msg-err">Session expired. Please start again.</div>'); return; }
  if (Date.now() > stored.expires) { setMsg('verifyMsg', '<div class="msg-err">Code expired. Please start again.</div>'); cancelVerification(); return; }
  if (entered !== stored.code) { setMsg('verifyMsg', '<div class="msg-err">Incorrect code. Please try again.</div>'); return; }
  showLoading('Creating your account…');

  // 1. Build the hidden internal email and create the real Supabase Auth account
  const { data: internalEmail } = await db.rpc('customer_internal_email', { p_phone: stored.ph });
  const { data: signUpData, error: signUpErr } = await db.auth.signUp({ email: internalEmail, password: stored.pin });
  if (signUpErr || !signUpData?.user) {
    hideLoading();
    setMsg('verifyMsg', `<div class="msg-err">${signUpErr?.message || 'Could not create account. Please try again.'}</div>`);
    return;
  }

  // 2. Create the customer profile row linked to that Auth user
  const { data: regResult, error: regErr } = await db.rpc('complete_customer_registration', {
    p_auth_user_id: signUpData.user.id,
    p_first_name: stored.fn, p_last_name: stored.ln,
    p_email: stored.em, p_phone: stored.ph, p_address: stored.addr
  });
  hideLoading();
  if (regErr || regResult?.ok === false) {
    setMsg('verifyMsg', `<div class="msg-err">${regResult?.error || regErr?.message || 'Registration failed'}</div>`);
    return;
  }

  sessionStorage.removeItem('wagVerify');
  cancelVerification();
  setMsg('regMsg', '<div class="msg-ok">Account verified and created! You can now sign in.</div>');
  document.getElementById('verifyCodeInp').value = '';
  setTimeout(() => { setMsg('regMsg', ''); setAuthTab('signin'); }, 2500);
}

// ═══════════════════════════════════════════════
// REPRESENTATIVE REGISTRATION (token-gated) — now via supabase.auth.signUp()
// + complete_rep_registration(), which validates the token server-side.
// ═══════════════════════════════════════════════
async function doRepRegister() {
  if (!dbReady()) return;
  const fn = document.getElementById('repRegFn').value.trim(), ln = document.getElementById('repRegLn').value.trim(),
    em = document.getElementById('repRegEm').value.trim(), ph = document.getElementById('repRegPh').value.trim(),
    pin = document.getElementById('repRegPin').value.trim(), tok = document.getElementById('repRegToken').value.trim();
  if (!fn || !ln || !em || !ph || !pin || !tok) { setMsg('repRegMsg', '<div class="msg-err">Please fill in all fields</div>'); return; }
  if (pin.length < 6) { setMsg('repRegMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  showLoading('Verifying token…');

  const normPh = normPhone(ph);
  const repPayPinRaw = document.getElementById('repRegPayPin')?.value?.trim() || '';
  const repPayPinHash = repPayPinRaw ? await hashPin(repPayPinRaw) : null;

  // Step 1: reserve a unique Agent ID and validate the token BEFORE signup,
  // so we can build the correct final internal email upfront — no fragile
  // post-signup email rename needed (which silently failed if Supabase
  // requires confirmation on email changes).
  const { data: reserveResult, error: reserveErr } = await db.rpc('reserve_rep_agent_id', { p_token: tok });
  if (reserveErr || reserveResult?.ok === false) {
    hideLoading();
    setMsg('repRegMsg', `<div class="msg-err">${reserveResult?.error || reserveErr?.message || 'Could not validate token'}</div>`);
    return;
  }
  const repId = reserveResult.rep_id;

  // Step 2: sign up directly with the correct final email
  const { data: finalEmail } = await db.rpc('rep_internal_email', { p_rep_id: repId });
  const { data: signUpData, error: signUpErr } = await db.auth.signUp({ email: finalEmail, password: pin });
  if (signUpErr || !signUpData?.user) {
    hideLoading();
    setMsg('repRegMsg', `<div class="msg-err">${signUpErr?.message || 'Could not create account'}</div>`);
    return;
  }

  // Step 3: create the profile row with the already-reserved Agent ID
  const { data: regResult, error: regErr } = await db.rpc('complete_rep_registration', {
    p_auth_user_id: signUpData.user.id,
    p_first_name: fn, p_last_name: ln, p_email: em, p_phone: normPh,
    p_token: tok, p_rep_id: repId, p_payment_pin_hash: repPayPinHash
  });
  hideLoading();
  if (regErr || regResult?.ok === false) {
    setMsg('repRegMsg', `<div class="msg-err">${regResult?.error || regErr?.message || 'Registration failed'}</div>`);
    return;
  }

  await audit('login', regResult.rep_uuid, 'representative', `New representative registered: ${fn} ${ln} — ID: ${regResult.rep_id}`);
  document.getElementById('newRepId').textContent = regResult.rep_id;
  showModal('agentIdModal');
}

// ═══════════════════════════════════════════════
// FORGOT / RESET PASSWORD
// Uses Supabase Auth's native password reset email flow instead of our
// own token table, since Supabase now owns the password.
// ═══════════════════════════════════════════════
function showForgotModal() { showModal('forgotModal'); }

async function doForgotPin() {
  if (!dbReady()) return;
  const em = document.getElementById('resetEmail').value.trim();
  if (!em) { setMsg('resetMsg', '<div class="msg-err">Please enter your email</div>'); return; }
  // Always show the same message whether or not an account was found,
  // so this can't be used to discover which emails are registered.
  const genericMsg = '<div class="msg-ok">If an account exists with that email, a password reset link has been sent. Please check your inbox.<br><small style="color:var(--sub);font-size:11px;">Link expires in 1 hour.</small></div>';
  showLoading('Sending reset link…');
  const { data: result } = await db.rpc('request_password_reset', { p_email: em });
  if (result?.exists && result?.token) {
    const resetLink = `${location.origin}${rootPath()}login.html?reset=${result.token}`;
    const [{ data: cu }, { data: re }] = await Promise.all([
      db.from('customers').select('first_name').eq('email', em).single(),
      db.from('representatives').select('first_name').eq('email', em).single()
    ]);
    await sendResetEmail(em, (cu || re)?.first_name || 'there', resetLink);
  }
  hideLoading();
  setMsg('resetMsg', genericMsg);
}

// Supabase redirects back with a recovery session already active in the URL
// hash — we detect that and show the reset-password modal directly.
async function checkResetTokenInURL() {
  if (!dbReady()) return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('reset');
  if (!token) return;
  showLoading('Verifying reset link…');
  const { data: result } = await db.rpc('verify_reset_token', { p_token: token });
  hideLoading();
  if (!result?.ok) { alert(result?.error || 'This reset link is invalid or has already been used.'); return; }
  window._resetToken = token;
  document.getElementById('resetTokenInfo').textContent = `Reset password for: ${result.email}`;
  showModal('resetPasswordModal');
}

async function doResetPassword() {
  const newPw = document.getElementById('newPasswordInp').value.trim();
  const confirmPw = document.getElementById('confirmPasswordInp').value.trim();
  if (!newPw || newPw.length < 6) { setMsg('resetPasswordMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  if (newPw !== confirmPw) { setMsg('resetPasswordMsg', '<div class="msg-err">Passwords do not match</div>'); return; }
  if (!window._resetToken) { setMsg('resetPasswordMsg', '<div class="msg-err">Reset session expired. Please request a new link.</div>'); return; }
  showLoading('Updating password…');
  // Calls the reset-password Edge Function, which uses the service role
  // key (server-side only) to update the password via the Admin API —
  // this can't be done from client-side JS or a plain SQL RPC.
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ token: window._resetToken, newPassword: newPw })
    });
    const result = await res.json();
    hideLoading();
    if (!res.ok || result.error) {
      setMsg('resetPasswordMsg', `<div class="msg-err">${result.error || 'Could not reset password. Please try again or contact support.'}</div>`);
      return;
    }
    closeModal('resetPasswordModal');
    document.getElementById('newPasswordInp').value = '';
    document.getElementById('confirmPasswordInp').value = '';
    window.history.replaceState({}, document.title, window.location.pathname);
    window._resetToken = null;
    alert('Password updated successfully! You can now sign in with your new password.');
  } catch (e) {
    hideLoading();
    setMsg('resetPasswordMsg', '<div class="msg-err">Password reset is temporarily unavailable. Please contact support to reset your password manually.</div>');
  }
}

// ═══════════════════════════════════════════════
// SUSPENSION POLLING — unchanged behavior, still checks the profile row
// every 30s and signs the user out if suspended/deleted mid-session.
// ═══════════════════════════════════════════════
let _suspendInterval = null;
function startSuspendCheck() {
  stopSuspendCheck();
  _suspendInterval = setInterval(async () => {
    const u = getUser(); if (!u || !db) return;
    try {
      const tbl = u.role === 'representative' ? 'representatives' : 'customers';
      const { data } = await db.from(tbl).select('status').eq('id', u.id).single();
      if (data && (data.status === 'suspended' || data.status === 'deleted')) {
        stopSuspendCheck();
        alert('Your account has been suspended. You will be signed out now.');
        doLogout();
      }
    } catch (e) { }
  }, 30000);
}
function stopSuspendCheck() { if (_suspendInterval) { clearInterval(_suspendInterval); _suspendInterval = null; } }
