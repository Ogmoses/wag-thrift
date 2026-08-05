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
// When "Remember Me" is checked, profile cache goes to localStorage
// (survives browser restarts). Otherwise sessionStorage (clears on close).
const WAG_USER_KEY = 'wagUser';
const WAG_REMEMBER_KEY = 'wagRememberMe';

function isRemembered() { return localStorage.getItem(WAG_REMEMBER_KEY) === 'true'; }

function getUser() {
  try {
    const raw = isRemembered()
      ? localStorage.getItem(WAG_USER_KEY)
      : (sessionStorage.getItem(WAG_USER_KEY) || localStorage.getItem(WAG_USER_KEY));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function setUser(u) {
  const json = JSON.stringify(u);
  if (isRemembered()) {
    localStorage.setItem(WAG_USER_KEY, json);
    sessionStorage.removeItem(WAG_USER_KEY);
  } else {
    sessionStorage.setItem(WAG_USER_KEY, json);
    localStorage.removeItem(WAG_USER_KEY);
  }
}

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

  if (error || !data) {
    // Couldn't reach the server to check — don't treat that the same as
    // "this session is invalid". A remembered session should survive
    // being temporarily offline; only a genuine, confirmed rejection
    // (wrong/suspended/deleted account) should log someone out.
    const isNetworkIssue = isConnectivityError(error);
    if (isNetworkIssue) {
      const cached = getUser();
      if (cached && cached.role === expectedRole) return cached;
    }
    return null;
  }

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
  await db.from('audit_log').insert({ action, user_id: String(userId), user_role: userRole, description, amount, plan_id: planId });
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
// Distinguishes "couldn't reach the server" from a genuine rejection, so
// login (and other network calls) can show an accurate message instead of
// a misleading "invalid credentials" when the real problem is signal.
function isConnectivityError(error) {
  return !navigator.onLine || /fetch|network|load failed|timed out|timeout|offline/i.test(error?.message || '');
}

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
    const { data: emailResult, error: emailErr } = await db.rpc('get_login_email_for_phone', { p_phone: normPh });
    if (!emailResult) {
      hideLoading();
      if (isConnectivityError(emailErr)) { setMsg('loginMsg', '<div class="msg-err">No connection right now. Please check your signal and try again.</div>'); return; }
      const locked = await checkFailedPin(normPh); setMsg('loginMsg', `<div class="msg-err">Invalid phone or password.${locked ? ' Account locked.' : ''}</div>`); return;
    }

    const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email: emailResult, password: deriveAuthPassword(pin) });
    if (authErr || !authData?.session) {
      hideLoading();
      if (isConnectivityError(authErr)) { setMsg('loginMsg', '<div class="msg-err">No connection right now. Please check your signal and try again.</div>'); return; }
      const locked = await checkFailedPin(normPh); setMsg('loginMsg', `<div class="msg-err">Invalid phone or password.${locked ? ' Account locked.' : ''}</div>`); return;
    }

    const profile = await refreshUserProfile('customer');
    if (!profile) {
      hideLoading();
      await db.auth.signOut();
      setMsg('loginMsg', '<div class="msg-err">This account has been suspended or could not be found. Please contact support.</div>');
      return;
    }

    // Save remember-me preference BEFORE setUser so storage target is correct
    const rememberMe = document.getElementById('rememberMe')?.checked || false;
    localStorage.setItem(WAG_REMEMBER_KEY, rememberMe ? 'true' : 'false');

    await db.from('pin_attempts').upsert({ phone: normPh, attempts: 0 });
    await audit('login', profile.id, 'customer', `Customer signed in: ${profile.first_name} ${profile.last_name}`);
    hideLoading();
    window.location.href = rootPath() + ROLE_HOME.customer;
  } else {
    const rid = document.getElementById('loginRepId').value.trim(), pin = document.getElementById('loginRepPin').value.trim();
    showLoading('Signing in…');

    const { data: emailResult, error: emailErr } = await db.rpc('get_login_email_for_rep_id', { p_rep_id: rid });
    if (!emailResult) {
      hideLoading();
      if (isConnectivityError(emailErr)) { setMsg('loginRepMsg', '<div class="msg-err">No connection right now. Please check your signal and try again.</div>'); return; }
      setMsg('loginRepMsg', '<div class="msg-err">Invalid Agent ID or password</div>'); return;
    }

    const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email: emailResult, password: pin });
    if (authErr || !authData?.session) {
      hideLoading();
      if (isConnectivityError(authErr)) { setMsg('loginRepMsg', '<div class="msg-err">No connection right now. Please check your signal and try again.</div>'); return; }
      setMsg('loginRepMsg', '<div class="msg-err">Invalid Agent ID or password</div>'); return;
    }

    // Save remember-me preference BEFORE refreshUserProfile (which calls
    // setUser internally) so the storage target — localStorage vs.
    // sessionStorage — is already correct by the time the profile is cached.
    const rememberMeRep = document.getElementById('rememberMeRep')?.checked || false;
    localStorage.setItem(WAG_REMEMBER_KEY, rememberMeRep ? 'true' : 'false');

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
  sessionStorage.removeItem(WAG_USER_KEY);
  localStorage.removeItem(WAG_USER_KEY);
  // Keep WAG_REMEMBER_KEY so the checkbox stays checked next visit
  window.location.href = rootPath() + 'login.html';
}

// Fix: sql/002's cross-role phone trigger raises a raw Postgres exception
// (PHONE_ALREADY_AGENT / PHONE_ALREADY_CUSTOMER) as a last line of defense.
// Translate it into a friendly message if it ever surfaces here.
function friendlyRegError(msg) {
  if (!msg) return msg;
  if (msg.includes('PHONE_ALREADY_AGENT')) return 'This phone number is already registered to a Field Agent account. Please use a different phone number.';
  if (msg.includes('PHONE_ALREADY_CUSTOMER')) return 'This phone number is already registered to a Customer account. Please use a different phone number.';
  // Fix: a raw Postgres unique-constraint violation used to leak straight
  // to the admin verbatim (e.g. 'duplicate key value violates unique
  // constraint "customers_email_key"') whenever the synthetic
  // placeholder email/phone collided with an existing row that hadn't
  // been anonymized yet. Translate the common ones into something
  // readable instead of surfacing raw SQL.
  if (/duplicate key value violates unique constraint/i.test(msg)) {
    if (/email/i.test(msg)) return 'An account with this email already exists. If this phone number was recently deleted, its old account may not be fully cleared yet — contact your developer.';
    if (/phone/i.test(msg)) return 'An account with this phone number already exists.';
    return 'An account with these details already exists.';
  }
  return msg;
}

// ═══════════════════════════════════════════════
// CUSTOMER SELF-REGISTRATION — REMOVED.
// Customers are no longer able to sign themselves up. The only way a
// customer account gets created now is a field agent using "Add New
// Customer" (doAgentCreateCustomer() below), which skips email/OTP
// entirely and uses just phone + name + a 4-digit PIN. register.html no
// longer has a customer registration form at all.
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// REPRESENTATIVE REGISTRATION (token-gated) — now via supabase.auth.signUp()
// + complete_rep_registration(), which validates the token server-side.
// ═══════════════════════════════════════════════
async function doRepRegister() {
  if (!dbReady()) return;
  const fn = document.getElementById('repRegFn').value.trim(), ln = document.getElementById('repRegLn').value.trim(),
    em = document.getElementById('repRegEm').value.trim(), ph = document.getElementById('repRegPh').value.trim(),
    pin = document.getElementById('repRegPin').value.trim(), tok = document.getElementById('repRegToken').value.trim();
  const repPayPinRaw = document.getElementById('repRegPayPin')?.value?.trim() || '';
  // Email is optional — falls back to a synthetic placeholder (same scheme
  // customer accounts use, see syntheticPlaceholderEmail() in js/utils.js)
  // so the profile page can show a clean "+ Add Email" prompt instead of
  // that placeholder. Payment PIN is now REQUIRED — every representative
  // must be able to authorize deposits/withdrawals from day one.
  if (!fn || !ln || !ph || !pin || !tok) { setMsg('repRegMsg', '<div class="msg-err">Please fill in all required fields</div>'); return; }
  if (pin.length < 6) { setMsg('repRegMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  if (!/^\d{4,6}$/.test(repPayPinRaw)) { setMsg('repRegMsg', '<div class="msg-err">Payment PIN is required and must be 4–6 digits</div>'); return; }
  showLoading('Verifying token…');

  const normPh = normPhone(ph);
  const repPayPinHash = await hashPin(repPayPinRaw);

  // Fix: block registering a Field Agent account with a phone number
  // that's already in use by a Customer (strict, cross-role uniqueness).
  // The DB also enforces this server-side (see sql/002).
  const { data: existingCust } = await db.from('customers').select('id').eq('phone', normPh).neq('status', 'deleted').maybeSingle();
  if (existingCust) { hideLoading(); setMsg('repRegMsg', '<div class="msg-err">This phone number is already registered to a Customer account. Please use a different phone number.</div>'); return; }

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
    p_first_name: fn, p_last_name: ln, p_email: em || syntheticPlaceholderEmail(normPh), p_phone: normPh,
    p_token: tok, p_rep_id: repId, p_payment_pin_hash: repPayPinHash
  });
  hideLoading();
  if (regErr || regResult?.ok === false) {
    setMsg('repRegMsg', `<div class="msg-err">${friendlyRegError(regResult?.error || regErr?.message) || 'Registration failed'}</div>`);
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
  if (!WORKER_URL) {
    setMsg('resetMsg', '<div class="msg-err">Password reset is not yet available. Please contact support.</div>');
    return;
  }
  // Always show the same message whether or not an account was found,
  // so this can't be used to discover which emails are registered.
  const genericMsg = '<div class="msg-ok">If an account exists with that email, a password reset link has been sent. Please check your inbox.<br><small style="color:var(--sub);font-size:11px;">Link expires in 15 minutes.</small></div>';
  showLoading('Sending reset link…');
  // The token is generated AND the email is sent entirely server-side now
  // (see requestPasswordReset() in js/supabase.js) — it never reaches
  // this browser at all, unlike the old two-step flow.
  await requestPasswordReset(em);
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
  if (!WORKER_URL) {
    hideLoading();
    setMsg('resetPasswordMsg', '<div class="msg-err">Password reset completion is not yet available. Please contact support to reset your password manually.</div>');
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/api/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    setMsg('resetPasswordMsg', '<div class="msg-err">Password reset is temporarily unavailable. Please contact support.</div>');
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
