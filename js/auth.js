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
  await db.from('audit_log').insert({ action, user_id: userId, user_role: userRole, description, amount, plan_id: planId });
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

  // We don't know the Agent ID yet (generated server-side), so we can't build
  // the internal email until after complete_rep_registration runs. Instead,
  // sign up with a temporary placeholder email derived from the token, then
  // the RPC assigns the real Agent ID and we don't need to rename the Auth
  // email — Supabase Auth email is just an internal key, never shown to the rep.
  const tempEmail = 'pending-' + tok.slice(0, 8) + '-' + Date.now() + '@wag.internal';
  const { data: signUpData, error: signUpErr } = await db.auth.signUp({ email: tempEmail, password: pin });
  if (signUpErr || !signUpData?.user) {
    hideLoading();
    setMsg('repRegMsg', `<div class="msg-err">${signUpErr?.message || 'Could not create account'}</div>`);
    return;
  }

  const { data: regResult, error: regErr } = await db.rpc('complete_rep_registration', {
    p_auth_user_id: signUpData.user.id,
    p_first_name: fn, p_last_name: ln, p_email: em, p_phone: normPh,
    p_token: tok, p_payment_pin_hash: repPayPinHash
  });
  if (regErr || regResult?.ok === false) {
    hideLoading();
    setMsg('repRegMsg', `<div class="msg-err">${regResult?.error || regErr?.message || 'Registration failed'}</div>`);
    return;
  }

  // Now that we have the real Agent ID, update the Auth user's email to the
  // proper internal format so future logins via get_login_email_for_rep_id work.
  const { data: finalEmail } = await db.rpc('rep_internal_email', { p_rep_id: regResult.rep_id });
  await db.auth.updateUser({ email: finalEmail });

  await audit('login', regResult.rep_uuid, 'representative', `New representative registered: ${fn} ${ln} — ID: ${regResult.rep_id}`);
  hideLoading();
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
  const [{ data: cu }, { data: re }] = await Promise.all([
    db.from('customers').select('id,first_name,auth_user_id').eq('email', em).single(),
    db.from('representatives').select('id,first_name,auth_user_id').eq('email', em).single()
  ]);
  if (!cu && !re) { setMsg('resetMsg', '<div class="msg-err">No account found with that email</div>'); return; }
  showLoading('Generating link…');
  // NOTE: Supabase's native resetPasswordForEmail() sends to the ACCOUNT's
  // real email field (cu.email/re.email), which is the contact email the
  // user registered with — NOT the hidden @wag.internal login email.
  const { error } = await db.auth.resetPasswordForEmail(em, {
    redirectTo: `${location.origin}${rootPath()}login.html`
  });
  hideLoading();
  if (error) { setMsg('resetMsg', `<div class="msg-err">${error.message}</div>`); return; }
  setMsg('resetMsg', `<div class="msg-ok">A password reset link has been sent to <strong>${em}</strong>. Please check your inbox.<br><small style="color:var(--sub);font-size:11px;">Link expires in 1 hour.</small></div>`);
}

// Supabase redirects back with a recovery session already active in the URL
// hash — we detect that and show the reset-password modal directly.
async function checkResetTokenInURL() {
  if (!dbReady()) return;
  const hash = window.location.hash;
  if (!hash.includes('type=recovery')) return;
  showLoading('Verifying reset link…');
  const { data: { session } } = await db.auth.getSession();
  hideLoading();
  if (!session) { alert('This reset link is invalid or has already been used.'); return; }
  document.getElementById('resetTokenInfo').textContent = `Reset password for: ${session.user.email}`;
  showModal('resetPasswordModal');
}

async function doResetPassword() {
  const newPw = document.getElementById('newPasswordInp').value.trim();
  const confirmPw = document.getElementById('confirmPasswordInp').value.trim();
  if (!newPw || newPw.length < 6) { setMsg('resetPasswordMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  if (newPw !== confirmPw) { setMsg('resetPasswordMsg', '<div class="msg-err">Passwords do not match</div>'); return; }
  showLoading('Updating password…');
  const { error } = await db.auth.updateUser({ password: newPw });
  hideLoading();
  if (error) { setMsg('resetPasswordMsg', `<div class="msg-err">${error.message}</div>`); return; }
  closeModal('resetPasswordModal');
  document.getElementById('newPasswordInp').value = '';
  document.getElementById('confirmPasswordInp').value = '';
  window.history.replaceState({}, document.title, window.location.pathname);
  await db.auth.signOut();
  alert('Password updated successfully! You can now sign in with your new password.');
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
