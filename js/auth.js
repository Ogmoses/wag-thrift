// ═══════════════════════════════════════════════
// js/auth.js
// SESSION MANAGEMENT · LOGIN/LOGOUT/REGISTER · ROUTE GUARDS
// AUDIT LOGGING · FRAUD DETECTION
// Depends on: js/supabase.js, js/utils.js (load both first)
// ═══════════════════════════════════════════════

// ── SHA-256 PIN hashing
async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── SESSION HELPERS (Supabase-powered)
function getUser() { try { return JSON.parse(sessionStorage.getItem('wagUser')); } catch (e) { return null; } }
function setUser(u) { sessionStorage.setItem('wagUser', JSON.stringify(u)); }

// ── ROUTE GUARDS
// Map of role -> dashboard URL (relative to site root), used for redirects
// after login / wrong-role access. Always combine with rootPath().
const ROLE_HOME = {
  customer: 'customer/dashboard.html',
  representative: 'representative/dashboard.html',
  admin: 'admin/dashboard.html'
};

// Call at the top of every protected customer/representative page.
// allowedRoles: array of role strings allowed to view this page (e.g. ['customer'])
function requireRole(allowedRoles) {
  const u = getUser();
  if (!u || !u.role) {
    window.location.replace(rootPath() + 'login.html');
    return null;
  }
  if (!allowedRoles.includes(u.role)) {
    // Logged in, but wrong role for this page — never silently allow via URL change
    window.location.replace(rootPath() + (ROLE_HOME[u.role] || 'login.html'));
    return null;
  }
  return u;
}

// Note: admin session helpers (getAdminSession/setAdminSession/clearAdminSession/
// requireAdmin) and the admin audit() live in js/admin.js — admin pages do NOT
// load this file, keeping admin fully isolated from customer/rep auth.

// ═══════════════════════════════════════════════
// AUDIT LOGGING
// ═══════════════════════════════════════════════
async function audit(action, userId, userRole, description, amount = null, planId = null) {
  await db.from('audit_log').insert({ action, user_id: userId, user_role: userRole, description, amount, plan_id: planId });
}

// ═══════════════════════════════════════════════
// FRAUD DETECTION — writes to Supabase
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
async function checkFailedPin(phone) {
  const { data } = await db.from('pin_attempts').select('attempts').eq('phone', phone).single();
  const attempts = (data?.attempts || 0) + 1;
  await db.from('pin_attempts').upsert({ phone, attempts, last_attempt: new Date().toISOString() });
  if (attempts === 3) await flagFraud('FAILED_PIN_ATTEMPTS', 'medium', phone, `3 failed PIN attempts for ${phone}`);
  return attempts >= 5;
}

// ═══════════════════════════════════════════════
// LOGIN
// currentRole is set by the login page UI ('customer' | 'representative')
// On success, redirects to the role's dashboard page (real navigation).
// ═══════════════════════════════════════════════
async function doLogin() {
  if (!dbReady()) return;
  if (currentRole === 'customer') {
    const rawPh = document.getElementById('loginPhone').value.trim(), pin = document.getElementById('loginPin').value.trim();
    const normPh = normPhone(rawPh);
    showLoading('Signing in…');
    const { data: attempts } = await db.from('pin_attempts').select('attempts').eq('phone', normPh).single();
    if ((attempts?.attempts || 0) >= 5) { hideLoading(); setMsg('loginMsg', '<div class="msg-err">Account locked due to too many failed attempts.</div>'); return; }
    const pinHash = await hashPin(pin);
    const { data: cust } = await db.from('customers').select('*').eq('phone', normPh).eq('pin_hash', pinHash).single();
    if (!cust) { hideLoading(); const locked = await checkFailedPin(normPh); setMsg('loginMsg', `<div class="msg-err">Invalid phone or password.${locked ? ' Account locked.' : ''}</div>`); return; }
    if (cust.status === 'suspended') { hideLoading(); setMsg('loginMsg', '<div class="msg-err">This account has been suspended. Please contact support.</div>'); return; }
    await db.from('pin_attempts').upsert({ phone: normPh, attempts: 0 });
    await audit('login', cust.id, 'customer', `Customer signed in: ${cust.first_name} ${cust.last_name}`);
    setUser({ ...cust, role: 'customer' }); hideLoading();
    window.location.href = rootPath() + ROLE_HOME.customer;
  } else {
    const rid = document.getElementById('loginRepId').value.trim(), pin = document.getElementById('loginRepPin').value.trim();
    showLoading('Signing in…');
    const pinHash = await hashPin(pin);
    const { data: rep } = await db.from('representatives').select('*').eq('rep_id', rid).eq('pin_hash', pinHash).single();
    if (!rep) { hideLoading(); setMsg('loginRepMsg', '<div class="msg-err">Invalid Agent ID or password</div>'); return; }
    if (rep.status === 'suspended') { hideLoading(); setMsg('loginRepMsg', '<div class="msg-err">This agent account has been suspended. Please contact your supervisor.</div>'); return; }
    await audit('login', rep.id, 'representative', `Representative signed in: ${rep.first_name} ${rep.last_name} (${rep.rep_id})`);
    setUser({ ...rep, role: 'representative' }); hideLoading();
    window.location.href = rootPath() + ROLE_HOME.representative;
  }
}

// ═══════════════════════════════════════════════
// LOGOUT — clears session and performs a real navigation to the login page.
// Works for customer/representative sessions. Admin uses adminLogout() in admin.js.
// ═══════════════════════════════════════════════
async function doLogout() {
  stopSuspendCheck();
  const u = getUser();
  if (u) await audit('login', u.id, u.role || 'unknown', `${u.first_name} ${u.last_name} signed out`);
  sessionStorage.removeItem('wagUser');
  localStorage.removeItem('wagActiveUser');
  window.location.href = rootPath() + 'login.html';
}

// ═══════════════════════════════════════════════
// REGISTRATION (customer) — email verification flow
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
    document.getElementById('verifyInfo').innerHTML = `! Could not send email automatically. <br><small style="color:var(--sub);">Your code is: <strong style="font-family:monospace;color:var(--blue);font-size:16px;">${code}</strong></small>`;
  } else if (result.demo) {
    document.getElementById('verifyInfo').innerHTML = ` EmailJS not configured yet.<br><small style="color:var(--sub);">For now your code is: <strong style="font-family:monospace;color:var(--blue);font-size:16px;">${code}</strong></small>`;
  } else {
    document.getElementById('verifyInfo').innerHTML = ` A 6-digit verification code has been sent to <strong>${em}</strong>. Please check your inbox and enter the code below.`;
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
  const pinHash = await hashPin(stored.pin);
  const { error } = await db.from('customers').insert({ first_name: stored.fn, last_name: stored.ln, email: stored.em, phone: stored.ph, address: stored.addr, pin_hash: pinHash });
  hideLoading();
  if (error) { setMsg('verifyMsg', `<div class="msg-err">${error.message.includes('unique') ? 'Phone or email already registered' : error.message}</div>`); return; }
  await audit('login', stored.ph, 'customer', `New customer registered: ${stored.fn} ${stored.ln}`);
  sessionStorage.removeItem('wagVerify');
  cancelVerification();
  setMsg('regMsg', '<div class="msg-ok"> Account verified and created! You can now sign in.</div>');
  document.getElementById('verifyCodeInp').value = '';
  setTimeout(() => { setMsg('regMsg', ''); setAuthTab('signin'); }, 2500);
}

// ═══════════════════════════════════════════════
// REPRESENTATIVE REGISTRATION (token-gated)
// ═══════════════════════════════════════════════
async function doRepRegister() {
  if (!dbReady()) return;
  const fn = document.getElementById('repRegFn').value.trim(), ln = document.getElementById('repRegLn').value.trim(),
    em = document.getElementById('repRegEm').value.trim(), ph = document.getElementById('repRegPh').value.trim(),
    pin = document.getElementById('repRegPin').value.trim(), tok = document.getElementById('repRegToken').value.trim();
  if (!fn || !ln || !em || !ph || !pin || !tok) { setMsg('repRegMsg', '<div class="msg-err">Please fill in all fields</div>'); return; }
  if (pin.length < 6) { setMsg('repRegMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  showLoading('Verifying token…');
  const { data: tokenRow } = await db.from('activation_tokens').select('*').eq('token', tok).eq('used', false).single();
  if (!tokenRow) { hideLoading(); setMsg('repRegMsg', '<div class="msg-err">Invalid or already used activation token</div>'); return; }
  const normPh = normPhone(ph), repId = genRepId(), pinHash = await hashPin(pin);
  const repPayPinRaw = document.getElementById('repRegPayPin')?.value?.trim() || '';
  const repPayPinHash = repPayPinRaw ? await hashPin(repPayPinRaw) : null;
  const { data: repData, error } = await db.from('representatives').insert({ first_name: fn, last_name: ln, email: em, phone: normPh, pin_hash: pinHash, rep_id: repId, payment_pin_hash: repPayPinHash }).select().single();
  if (error) { hideLoading(); setMsg('repRegMsg', `<div class="msg-err">${error.message}</div>`); return; }
  await db.from('activation_tokens').update({ used: true, used_by: repData.id, used_at: new Date().toISOString() }).eq('id', tokenRow.id);
  await audit('login', repId, 'representative', `New representative registered: ${fn} ${ln} — ID: ${repId}`);
  hideLoading();
  document.getElementById('newRepId').textContent = repId;
  showModal('agentIdModal');
}

// ═══════════════════════════════════════════════
// FORGOT / RESET PASSWORD
// ═══════════════════════════════════════════════
function showForgotModal() { showModal('forgotModal'); }

async function doForgotPin() {
  if (!dbReady()) return;
  const em = document.getElementById('resetEmail').value.trim();
  if (!em) { setMsg('resetMsg', '<div class="msg-err">Please enter your email</div>'); return; }
  const [{ data: cu }, { data: re }] = await Promise.all([
    db.from('customers').select('id,first_name').eq('email', em).single(),
    db.from('representatives').select('id,first_name').eq('email', em).single()
  ]);
  if (!cu && !re) { setMsg('resetMsg', '<div class="msg-err">No account found with that email</div>'); return; }
  showLoading('Generating link…');
  const token = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
  try { await db.from('password_resets').insert({ email: em, token, expires_at: new Date(Date.now() + 3600000).toISOString() }); } catch (e) { }
  hideLoading();
  const link = `${location.origin}/login.html?reset=${token}`;
  setMsg('resetMsg', `<div class="msg-ok">Reset link ready.<br><br><a href="${link}" style="color:var(--blue);font-weight:700;font-size:13px;">Tap here to reset your password</a><br><small style="color:var(--sub);font-size:11px;">Link expires in 1 hour.</small></div>`);
}

let activeResetToken = null;

async function checkResetTokenInURL() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('reset');
  if (!token) return;
  if (!dbReady()) return;
  showLoading('Verifying reset link…');
  const { data: row } = await db.from('password_resets')
    .select('*').eq('token', token).eq('used', false).single();
  hideLoading();
  if (!row) { alert('This reset link is invalid or has already been used.'); return; }
  if (new Date(row.expires_at) < new Date()) { alert('This reset link has expired. Please request a new one.'); return; }
  activeResetToken = row;
  document.getElementById('resetTokenInfo').textContent = `Reset password for: ${row.email}`;
  showModal('resetPasswordModal');
}

async function doResetPassword() {
  if (!activeResetToken) { alert('Invalid reset session'); return; }
  const newPw = document.getElementById('newPasswordInp').value.trim();
  const confirmPw = document.getElementById('confirmPasswordInp').value.trim();
  if (!newPw || newPw.length < 6) { setMsg('resetPasswordMsg', '<div class="msg-err">Password must be at least 6 characters</div>'); return; }
  if (newPw !== confirmPw) { setMsg('resetPasswordMsg', '<div class="msg-err">Passwords do not match</div>'); return; }
  showLoading('Updating password…');
  const pinHash = await hashPin(newPw);
  const email = activeResetToken.email;
  const { data: cust } = await db.from('customers').select('id').eq('email', email).single();
  if (cust) await db.from('customers').update({ pin_hash: pinHash }).eq('id', cust.id);
  const { data: rep } = await db.from('representatives').select('id').eq('email', email).single();
  if (rep) await db.from('representatives').update({ pin_hash: pinHash }).eq('id', rep.id);
  await db.from('password_resets').update({ used: true }).eq('token', activeResetToken.token);
  await audit('login', email, 'system', `Password reset completed for ${email}`);
  hideLoading();
  closeModal('resetPasswordModal');
  activeResetToken = null;
  document.getElementById('newPasswordInp').value = '';
  document.getElementById('confirmPasswordInp').value = '';
  window.history.replaceState({}, document.title, window.location.pathname);
  alert(' Password updated successfully! You can now sign in with your new password.');
}

// ═══════════════════════════════════════════════
// SUSPENSION POLLING — runs on every protected customer/rep page after login.
// If an admin suspends/deletes the account mid-session, the user is signed out.
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
