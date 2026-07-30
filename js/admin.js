// ═══════════════════════════════════════════════
// js/admin.js
// SUPER ADMIN PORTAL — AUTH & SESSION
// Now backed by REAL Supabase Auth (db.auth.*) + an `administrators` table
// gated by the is_admin() SQL function, replacing the old shared-PIN system.
// Still kept isolated from customer/rep auth (does not load js/auth.js) —
// the Supabase client's session handling is native to js/supabase.js, so
// that isolation is preserved.
// Depends on: js/supabase.js, js/utils.js (load both first)
// ═══════════════════════════════════════════════

// ── ADMIN SESSION — cached profile, refreshed from the live Supabase
// session + administrators table (mirrors refreshUserProfile() in auth.js
// but kept local here to avoid loading auth.js on admin pages).
function getAdminSession() { try { return JSON.parse(sessionStorage.getItem('wagAdmin')); } catch (e) { return null; } }
function setAdminSession(a) { sessionStorage.setItem('wagAdmin', JSON.stringify(a)); }
function clearAdminSession() { sessionStorage.removeItem('wagAdmin'); }

// Re-checks the live Supabase Auth session and confirms the user is an
// active admin via is_admin(). Returns the admin profile or null.
async function refreshAdminProfile() {
  if (!db) return null;
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user) return null;
  const { data: isAdminResult } = await db.rpc('is_admin');
  if (isAdminResult !== true) return null;
  const { data: profile } = await db.from('administrators').select('*').eq('auth_user_id', session.user.id).single();
  if (!profile || profile.status !== 'active') return null;
  const adminSession = { loggedIn: true, id: profile.id, first_name: profile.first_name, last_name: profile.last_name, email: profile.email, loginTime: new Date().toISOString() };
  setAdminSession(adminSession);
  return adminSession;
}

async function isAdminLoggedIn() {
  return !!(await refreshAdminProfile());
}

// Call at the top of every admin page (except admin/login.html).
// Synchronous quick-check using cache, paired with an async re-verify.
function requireAdmin() {
  // Detect a customer/representative session present in this browser and
  // immediately reject — they are never allowed past this point.
  let custOrRepSession = null;
  try { custOrRepSession = JSON.parse(sessionStorage.getItem('wagUser')); } catch (e) {}
  if (custOrRepSession && custOrRepSession.role) {
    alert('This area is restricted. You do not have permission to access the admin portal.');
    window.location.replace(rootPath() + (custOrRepSession.role === 'representative' ? 'representative/dashboard.html' : 'customer/dashboard.html'));
    return null;
  }

  const a = getAdminSession();
  if (!a || !a.loggedIn) {
    window.location.replace(rootPath() + 'admin/login.html');
    return null;
  }
  return a;
}

// The REAL, authoritative check — call this after requireAdmin() on every
// protected admin page. Re-verifies against the live Supabase session +
// is_admin(), so a revoked/expired session or a hand-edited sessionStorage
// value can't fake admin access.
async function verifyAdminFromDB() {
  const profile = await refreshAdminProfile();
  if (!profile) {
    clearAdminSession();
    window.location.replace(rootPath() + 'admin/login.html');
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════
// ADMIN AUDIT LOG WRITER
// ═══════════════════════════════════════════════
async function audit(action, description, amount = null, planId = null) {
  if (!db) return;
  const a = getAdminSession();
  await db.from('audit_log').insert({ action, user_id: a?.id || 'admin', user_role: 'super_admin', description, amount, plan_id: planId });
}

// ═══════════════════════════════════════════════
// SHARED ADMIN SHELL — sidebar + topbar + overlays + confirm modal
// Injected into #adminShellRoot at the top of every admin page (except login).
// ═══════════════════════════════════════════════
const ADMIN_NAV = [
  { id: 'overview', label: 'Overview', section: 'Main', href: 'dashboard.html', icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' },
  { id: 'disbursements', label: 'Disbursements', section: 'Main', href: 'dashboard.html#disbursements', badge: 'disbBadge', icon: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
  { id: 'customers', label: 'Customers', section: 'Users', href: 'users.html', icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
  { id: 'agents', label: 'Field Agents', section: 'Users', href: 'representatives.html', icon: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>' },
  { id: 'search', label: 'Search', section: 'System', href: 'users.html#search', icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
  { id: 'analytics', label: 'Analytics', section: 'System', href: 'analytics.html', icon: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' },
  { id: 'flags', label: 'Fraud Flags', section: 'System', href: 'analytics.html#flags', badge: 'flagBadge', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
  { id: 'tokens', label: 'Tokens', section: 'System', href: 'representatives.html#tokens', icon: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>' },
  { id: 'auditlog', label: 'Audit Log', section: 'System', href: 'settings.html#auditlog', icon: '<path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/>' },
  { id: 'settings', label: 'Settings', section: 'System', href: 'settings.html', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M19.07 19.07l-1.41-1.41M4.93 4.93l1.41 1.41M4.93 19.07l1.41-1.41M21 12h-2M5 12H3M12 21v-2M12 5V3"/>' }
];

function renderAdminShell(activePage, title) {
  currentPage = activePage;
  const sections = [...new Set(ADMIN_NAV.map(n => n.section))];
  const navHtml = sections.map(sec => `<div class="nav-section-lbl">${sec}</div>` + ADMIN_NAV.filter(n => n.section === sec).map(n => {
    const isActive = n.id === activePage;
    const badge = n.badge ? `<span class="nav-badge" id="${n.badge}" style="display:none;">0</span>` : '';
    return `<a class="nav-item${isActive ? ' active' : ''}" href="${n.href}" style="text-decoration:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;">${n.icon}</svg>${n.label}${badge}</a>`;
  }).join('')).join('');

  document.getElementById('adminShellRoot').innerHTML = `
<div class="loading-overlay" id="loadingOverlay">
  <div class="loading-spinner"></div>
  <div class="loading-text" id="loadingText">Please wait…</div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
<aside class="sidebar" id="sidebar">
  <div class="sidebar-top">
    <div class="sidebar-logo-row">
      <div class="sidebar-logo">WAG</div>
      <div><div class="sidebar-title">Super Admin</div><div class="sidebar-sub">Master Terminal</div></div>
    </div>
    <div class="sidebar-admin-info"><div class="sidebar-admin-name">Administrator</div><div class="sidebar-admin-role">Full System Access</div></div>
  </div>
  <nav class="sidebar-nav">${navHtml}</nav>
  <div class="sidebar-footer">
    <button class="sidebar-signout" onclick="doAdminLogout()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Sign Out</button>
  </div>
</aside>
<div class="topbar">
  <button class="topbar-hamburger" onclick="toggleSidebar()" style="display:flex;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
  <div class="topbar-title">${title}</div>
  <span class="topbar-badge">SUPER ADMIN</span>
  <button onclick="doAdminLogout()" title="Exit Portal" style="background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.3);color:#fca5a5;padding:6px 11px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;flex-shrink:0;white-space:nowrap;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Exit</button>
</div>
<div id="confirmModal" class="modal"><div class="msheet" style="position:relative;"><button class="m-close" onclick="closeModal('confirmModal')">×</button><div class="m-title" id="confirmTitle">Confirm Action</div><p style="color:var(--sub);font-size:13px;margin-bottom:18px;" id="confirmMsg">Are you sure?</p><div style="display:flex;gap:9px;"><button class="btn btn-ghost" onclick="closeModal('confirmModal')" style="flex:1;justify-content:center;">Cancel</button><button class="btn btn-yellow" style="flex:1;justify-content:center;" onclick="confirmOkHandler()">Confirm</button></div></div></div>`;

  updateBadges();
  setupRealtimeListeners();

  // Expose the topbar's rendered height as a CSS var so sticky elements
  // further down the page (e.g. the audit log search bar) can stick
  // immediately below it with no gap/overlap, regardless of device.
  requestAnimationFrame(() => {
    const tb = document.querySelector('.topbar');
    if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  });
}

let loginAttempts = 0;
let lockoutUntil = 0;
let _pendingMfaFactorId = null;
let _pendingMfaChallengeId = null;

// Called from admin/login.html — step 1: password.
async function doAdminLogin() {
  const btn = document.getElementById('loginBtn');
  const now = Date.now();
  if (now < lockoutUntil) { return; }

  const email = document.getElementById('adminEmailInp').value.trim();
  const pw = document.getElementById('adminPinInp').value;
  if (!email || !pw) { setMsg('loginMsg', '<div class="msg-err">Please enter your email and password</div>'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email, password: pw });

  if (authErr || !authData?.session) {
    const isConnectivityIssue = !navigator.onLine || /fetch|network|load failed|timed out|timeout|offline/i.test(authErr?.message || '');
    if (isConnectivityIssue) {
      setMsg('loginMsg', '<div class="msg-err">No connection right now. Please check your signal and try again.</div>');
    } else {
      await handleAdminLoginFailure('Invalid email or password');
    }
    btn.disabled = false;
    btn.textContent = 'Access Super Admin Portal';
    return;
  }

  // Password is correct. Before treating this as a real admin session,
  // check whether this account has 2FA enrolled and, if so, whether this
  // particular session still needs to complete that step.
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
    const { data: factors } = await db.auth.mfa.listFactors();
    const factor = factors?.totp?.find(f => f.status === 'verified');
    if (!factor) {
      // Shouldn't happen (nextLevel said aal2 is available) but fail safe.
      await db.auth.signOut();
      await handleAdminLoginFailure('Could not start 2FA verification. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Access Super Admin Portal';
      return;
    }
    const { data: challenge, error: challengeErr } = await db.auth.mfa.challenge({ factorId: factor.id });
    if (challengeErr) {
      await db.auth.signOut();
      await handleAdminLoginFailure('Could not start 2FA verification. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Access Super Admin Portal';
      return;
    }
    _pendingMfaFactorId = factor.id;
    _pendingMfaChallengeId = challenge.id;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mfaScreen').style.display = 'block';
    document.getElementById('mfaCodeInp').value = '';
    document.getElementById('mfaCodeInp').focus();
    btn.disabled = false;
    btn.textContent = 'Access Super Admin Portal';
    return;
  }

  // No 2FA required for this account — finish login the normal way.
  await finishAdminLogin();
}

// Step 2 (only shown if the account has 2FA enrolled) — called from the
// "Verify" button on the 2FA screen in admin/login.html.
async function doAdminMfaVerify() {
  const btn = document.getElementById('mfaVerifyBtn');
  const code = document.getElementById('mfaCodeInp').value.trim();
  if (!/^\d{6}$/.test(code)) { setMsg('mfaMsg', '<div class="msg-err">Enter the 6-digit code from your authenticator app</div>'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  const { error } = await db.auth.mfa.verify({
    factorId: _pendingMfaFactorId,
    challengeId: _pendingMfaChallengeId,
    code,
  });

  if (error) {
    loginAttempts++;
    if (loginAttempts >= 5) {
      await db.auth.signOut();
      lockoutUntil = Date.now() + 30000;
      document.getElementById('mfaScreen').style.display = 'none';
      document.getElementById('loginScreen').style.display = 'block';
      showLockout(30);
      return;
    }
    setMsg('mfaMsg', `<div class="msg-err">Incorrect code — ${5 - loginAttempts} attempt(s) remaining</div>`);
    document.getElementById('mfaCodeInp').value = '';
    document.getElementById('mfaCodeInp').focus();
    btn.disabled = false;
    btn.textContent = 'Verify';
    // A fresh challenge is needed after a failed attempt.
    const { data: challenge } = await db.auth.mfa.challenge({ factorId: _pendingMfaFactorId });
    if (challenge) _pendingMfaChallengeId = challenge.id;
    return;
  }

  await finishAdminLogin();
}

// Lets someone back out of the 2FA screen (e.g. wrong account) without
// leaving a half-authenticated session sitting open.
async function cancelAdminMfa() {
  await db.auth.signOut();
  _pendingMfaFactorId = null;
  _pendingMfaChallengeId = null;
  document.getElementById('mfaScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  setMsg('mfaMsg', '');
}

// Shared by both the no-2FA and post-2FA-verified paths.
async function finishAdminLogin() {
  const profile = await refreshAdminProfile();
  const success = !!profile;
  if (!success) await db.auth.signOut(); // signed in but not an active admin — reject

  await auditLoginAttempt(success);
  sessionLog.unshift({ type: success ? 'ok' : 'fail', time: new Date().toLocaleString() });

  if (success) {
    loginAttempts = 0;
    const pinInp = document.getElementById('adminPinInp');
    if (pinInp) pinInp.value = '';
    window.location.href = rootPath() + 'admin/dashboard.html';
  } else {
    await handleAdminLoginFailure('Access denied for this account');
  }
}

async function handleAdminLoginFailure(message) {
  loginAttempts++;
  document.getElementById('mfaScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  if (loginAttempts >= 5) {
    lockoutUntil = Date.now() + 30000;
    showLockout(30);
    setMsg('loginMsg', '');
  } else {
    setMsg('loginMsg', `<div class="msg-err">${message} — ${5 - loginAttempts} attempt(s) remaining</div>`);
  }
  const pinInp = document.getElementById('adminPinInp');
  if (pinInp) pinInp.value = '';
}

function showLockout(secs) {
  document.getElementById('lockoutMsg').style.display = 'block';
  document.getElementById('loginBtn').disabled = true;
  document.getElementById('loginBtn').textContent = `Locked — wait ${secs}s`;
  const iv = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(iv);
      document.getElementById('lockoutMsg').style.display = 'none';
      document.getElementById('loginBtn').disabled = false;
      document.getElementById('loginBtn').textContent = 'Access Super Admin Portal';
      loginAttempts = 0;
    } else {
      document.getElementById('lockoutTimer').textContent = secs;
      document.getElementById('loginBtn').textContent = `Locked — wait ${secs}s`;
    }
  }, 1000);
}

async function auditLoginAttempt(success) {
  if (!db) return;
  try {
    await db.from('audit_log').insert({
      action: 'login',
      user_id: 'admin',
      user_role: 'super_admin',
      description: `Admin portal login attempt — ${success ? 'SUCCESS' : 'FAILED'}`,
      amount: null,
      plan_id: null
    });
  } catch (e) { }
}

// Called from admin pages (sidebar/topbar logout button).
async function doAdminLogout() {
  if (typeof teardownRealtime === 'function') teardownRealtime();
  if (db) await db.auth.signOut();
  clearAdminSession();
  window.location.href = rootPath() + 'admin/login.html';
}

// ── Admin theme — system-aware, uses body.light-mode (admin portal defaults to DARK)
let _adminThemePref = 'system';
function adminSetTheme(pref) {
  _adminThemePref = pref;
  const isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('light-mode', !isDark);
  localStorage.setItem('wagAdminTheme', pref);
  ['light', 'dark', 'system'].forEach(t => {
    const el = document.getElementById('aTheme' + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) { el.style.borderColor = t === pref ? 'var(--yellow)' : 'var(--border)'; el.style.color = t === pref ? 'var(--yellow)' : 'var(--sub)'; }
  });
}
function initAdminTheme() {
  const saved = localStorage.getItem('wagAdminTheme') || 'system';
  adminSetTheme(saved);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (_adminThemePref === 'system') adminSetTheme('system');
  });
}
function toggleTheme() { adminSetTheme(document.body.classList.contains('light-mode') ? 'dark' : 'light'); }

// ── Session header helper for dashboard pages
function renderAdminSessionInfo() {
  const a = getAdminSession();
  const el = document.getElementById('sessionStart');
  if (el && a) el.textContent = fmtDate(a.loginTime) + ' ' + fmtTime(a.loginTime);
}

// ═══════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════
let sidebarOpen = false;
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
  document.getElementById('sidebarOverlay').classList.toggle('active', sidebarOpen);
}
function closeSidebar() {
  sidebarOpen = false;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
}

// `currentPage` is set inline by each admin page (e.g. 'overview', 'disbursements')
// and used by setupRealtimeListeners() to know what to re-render on DB changes.
let currentPage = 'overview';

// ═══════════════════════════════════════════════
// OVERVIEW (admin/dashboard.html)
// ═══════════════════════════════════════════════
async function renderOverview() {
  if (!db) return;
  const [
    { count: cc }, { count: rc }, { data: totals }, { count: planCnt }, { data: pendDisb },
    { count: pdc }, { count: flagCount }, { data: auditRows }
  ] = await Promise.all([
    db.from('customers').select('*', { count: 'exact', head: true }),
    db.from('representatives').select('*', { count: 'exact', head: true }),
    db.rpc('admin_transaction_totals'),
    db.from('plans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    // Show both pending AND reviewed here — admin can review or approve
    // directly from the Overview without navigating to the full Disbursements tab.
    db.from('disbursements').select('*,customers(first_name,last_name,phone)').in('status', ['pending', 'reviewed']).order('requested_at', { ascending: false }).limit(5),
    db.from('disbursements').select('*', { count: 'exact', head: true }).in('status', ['pending', 'reviewed']),
    db.from('fraud_flags').select('*', { count: 'exact', head: true }).eq('resolved', false),
    db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(10),
  ]);

  const totalDep = totals?.[0]?.total_deposits || 0;
  const totalPay = totals?.[0]?.total_payouts || 0;

  document.getElementById('ovCust').textContent = cc || 0;
  document.getElementById('ovReps').textContent = rc || 0;
  document.getElementById('ovDeposits').textContent = fmt(totalDep);
  document.getElementById('ovPayouts').textContent = fmt(totalPay);
  document.getElementById('ovPlans').textContent = planCnt || 0;

  document.getElementById('ovPendingDisb').textContent = pdc || 0;
  const badge = document.getElementById('disbBadge');
  if (badge) { if (pdc > 0) { badge.style.display = ''; badge.textContent = pdc; } else badge.style.display = 'none'; }

  if (!pendDisb?.length) {
    document.getElementById('ovDisbList').innerHTML = '<div class="empty-state">No pending withdrawals</div>';
  } else {
    document.getElementById('ovDisbList').innerHTML = pendDisb.map(d => renderDisbCard(d, true)).join('');
  }

  const flagBadgeEl = document.getElementById('flagBadge');
  if (flagBadgeEl) { flagBadgeEl.style.display = flagCount > 0 ? '' : 'none'; flagBadgeEl.textContent = flagCount || 0; }

  renderAuditRows('ovAuditList', auditRows || []);
}

// ═══════════════════════════════════════════════
// DISBURSEMENTS (admin/dashboard.html)
// ═══════════════════════════════════════════════
async function renderDisbPage() {
  const statusFilter = document.getElementById('disbFilterStatus').value;
  let q = db.from('disbursements').select('*,customers(first_name,last_name,phone)').order('requested_at', { ascending: false });
  if (statusFilter) q = q.eq('status', statusFilter);
  const { data: disbs } = await q;
  const el = document.getElementById('disbPageList');
  if (!disbs?.length) { el.innerHTML = '<div class="empty-state">No withdrawals found</div>'; return; }
  el.innerHTML = disbs.map(d => renderDisbCard(d, false)).join('');
}

function renderDisbCard(d, compact) {
  const stages = ['pending', 'reviewed', 'approved', 'paid'];
  const curIdx = stages.indexOf(d.status);
  const cust = d.customers || {};
  // Fix: use the name/phone snapshot captured at request time (sql/002)
  // first — falls back to the live join for any row created before that
  // migration. This keeps the disbursement card showing the real name
  // even if the customer account has since been deleted.
  const custName = d.customer_name || `${cust.first_name || 'Unknown'} ${cust.last_name || ''}`.trim();
  const custPhone = ((d.customer_phone || cust.phone) || '').replace('+234', '0');
  const canReview = d.status === 'pending';
  const canApprove = d.status === 'reviewed';
  const isApproved = d.status === 'approved';
  const canReject = d.status === 'pending' || d.status === 'reviewed';

  const stageBar = stages.map((s, i) => `<div class="stage-step"><div class="stage-dot ${i < curIdx ? 'done' : i === curIdx ? 'active' : ''}"></div><div class="stage-label">${s}</div></div>`).join('');

  const rejectBtn = `<button class="btn-reject" onclick="rejectDisb('${d.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Reject</button>`;

  const actions = canReview
    ? `<div class="disb-actions">
        <button class="btn-review" onclick="reviewDisb('${d.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Mark as Reviewed</button>
        ${rejectBtn}
       </div>`
    : canApprove
    ? `<div class="disb-actions">
        <button class="btn-review" onclick="approveDisb('${d.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Approve Withdrawal</button>
        ${rejectBtn}
       </div>`
    : isApproved
    ? `<div class="disb-actions"><div style="font-size:11px;color:var(--sub);padding:6px 2px;">Approved — representative will confirm cash delivery</div></div>`
    : canReject
    ? `<div class="disb-actions">${rejectBtn}</div>`
    : '';

  const phone = custPhone;

  return `<div class="disb-item">
    <div class="disb-header">
      <div>
        <div class="disb-name">${custName}</div>
        <div class="disb-phone">${phone}</div>
      </div>
      <div style="text-align:right;">
        <div class="disb-amount">${fmt(d.amount)}</div>
        <span class="status-pill ${d.status}">${d.status}</span>
      </div>
    </div>
    <div class="disb-stage-bar">${stageBar}</div>
    <div class="disb-reason">${d.reason || 'No reason provided'}</div>
    <div class="disb-meta">Requested: ${fmtDate(d.requested_at)} ${fmtTime(d.requested_at)} · Type: ${d.type || '—'} · Ref: ${d.ref || '—'}</div>
    ${actions}
  </div>`;
}

async function reviewDisb(disbId) {
  if (!confirm('Mark this withdrawal as REVIEWED?\nThis allows you to then approve it.')) return;
  showLoading('Updating…');
  const { data, error } = await db.rpc('mark_disbursement_reviewed', { p_disbursement_id: disbId });
  if (error) { hideLoading(); alert('Review failed: ' + error.message); return; }
  if (data === false) { hideLoading(); alert('Could not review — already reviewed or not found.'); return; }
  await audit('review', `Admin marked withdrawal ${disbId} as reviewed`);
  hideLoading();
  await renderOverview();
  if (currentPage === 'disbursements') await renderDisbPage();
}

async function approveDisb(disbId) {
  if (!confirm('APPROVE this withdrawal?\nThe balance will be deducted immediately and the representative will deliver cash to the customer.')) return;
  showLoading('Approving…');
  const { data, error } = await db.rpc('approve_disbursement', { p_disbursement_id: disbId });
  if (error) { hideLoading(); alert('Approval failed: ' + error.message); return; }
  if (data?.ok === false) { hideLoading(); alert('Approval failed: ' + (data.error || 'Unknown error')); return; }
  // NOTE: no audit() call here — approve_disbursement RPC already writes
  // its own audit_log entry server-side. A second call here would duplicate it.
  hideLoading();
  await renderOverview();
  if (currentPage === 'disbursements') await renderDisbPage();
}

// Fix 9: final payment step — admin only, calls server-side RPC
async function rejectDisb(disbId) {
  if (!confirm('Reject this withdrawal? This action cannot be undone.')) return;
  showLoading('Rejecting…');
  // Guard: never allow rejecting an already-approved/paid withdrawal —
  // the balance has already been deducted and there is no reversal logic.
  const { error } = await db.from('disbursements')
    .update({ status: 'rejected' })
    .eq('id', disbId)
    .in('status', ['pending', 'reviewed']);
  if (error) { hideLoading(); alert('Reject failed: ' + error.message); return; }
  await audit('reject', `Admin rejected withdrawal ${disbId}`);
  hideLoading();
  await renderOverview();
  if (currentPage === 'disbursements') await renderDisbPage();
}

// ═══════════════════════════════════════════════
// CUSTOMERS (admin/users.html)
// ═══════════════════════════════════════════════
let allCustomers = [];

async function renderCustomersPage() {
  // A generous cap, not full pagination — at real-world scale (low
  // thousands) a single list is still fine to load and keeps the
  // existing instant client-side search working. This exists purely so
  // the query is never truly unbounded if the customer base grows a lot
  // further down the line.
  // Fix: deleted customers used to still show up here (with a misleading
  // "Suspend" button, since the list only ever checked for 'suspended')
  // and counted toward the total — permanently deleted accounts should
  // disappear from this list entirely.
  const { data: custs } = await db.from('customers').select('*').neq('status', 'deleted').order('created_at', { ascending: false }).limit(2000);
  allCustomers = custs || [];
  renderCustomersList(allCustomers);
}

function renderCustomersList(custs) {
  const el = document.getElementById('custPageList');
  if (!el) return;
  if (!custs?.length) { el.innerHTML = '<div class="empty-state">No customers found</div>'; return; }
  el.innerHTML = `<div class="section-card"><div style="font-size:11px;color:var(--sub);margin-bottom:11px;">${custs.length} customer(s)</div>` +
    custs.map(c => {
      const isSuspended = c.status === 'suspended';
      const statusLabel = isSuspended ? '<span style="background:rgba(220,38,38,.15);color:#fca5a5;font-size:9px;font-weight:800;padding:2px 7px;border-radius:50px;letter-spacing:.5px;margin-left:6px;">SUSPENDED</span>' : '';
      const actionBtns = isSuspended
        ? `<button class="btn btn-green" onclick="restoreCustomer('${c.id}','${c.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.51"/></svg>Restore</button>
           <button class="btn btn-red" onclick="deleteCustomer('${c.id}','${c.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;margin-left:4px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>Delete</button>`
        : `<button class="btn btn-ghost" onclick="suspendCustomer('${c.id}','${c.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;">Suspend</button>`;
      return `<div class="cust-row">
        <div><div class="cust-row-name">${c.first_name} ${c.last_name}${statusLabel}</div><div class="cust-row-sub">${(c.phone || '').replace('+234', '0')}</div></div>
        <div class="cust-row-right"><div style="font-size:11px;color:var(--sub);">${fmtDate(c.created_at)}</div><div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${actionBtns}</div></div>
      </div>`;
    }).join('') + '</div>';
}

function filterCustomersPage() {
  const q = (document.getElementById('custSearchInp')?.value || '').toLowerCase();
  if (!q) { renderCustomersList(allCustomers); return; }
  renderCustomersList(allCustomers.filter(c => (c.first_name + ' ' + c.last_name).toLowerCase().includes(q) || (c.phone || '').includes(q)));
}

function showMigrationAlert(table) {
  alert('Database Setup Required\n\nThe \'status\' column is missing from your \'' + table + '\' table.\n\nTo fix this, go to:\nSupabase Dashboard → SQL Editor → New Query\n\nThen paste and run this SQL:\n\n' + `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';` + '\n\nAfter running it, refresh this page and try again.');
}

async function suspendCustomer(id, name) {
  showLoading('Suspending…');
  const { error } = await db.from('customers').update({ status: 'suspended' }).eq('id', id);
  if (error) {
    hideLoading();
    if (error.message && error.message.includes('status')) showMigrationAlert('customers');
    else alert('Error: ' + error.message);
    return;
  }
  await audit('flag', `Admin suspended customer ${name} (${id})`);
  hideLoading();
  allCustomers = allCustomers.map(x => x.id === id ? { ...x, status: 'suspended' } : x);
  renderCustomersList(allCustomers);
}

async function restoreCustomer(id, name) {
  showLoading('Restoring…');
  const { error } = await db.from('customers').update({ status: 'active' }).eq('id', id);
  if (error) {
    hideLoading();
    if (error.message && error.message.includes('status')) showMigrationAlert('customers');
    else alert('Error: ' + error.message);
    return;
  }
  await audit('flag', `Admin restored customer ${name} (${id})`);
  hideLoading();
  allCustomers = allCustomers.map(x => x.id === id ? { ...x, status: 'active' } : x);
  renderCustomersList(allCustomers);
}

// Frees up a permanently-deleted customer's/agent's phone number for reuse
// by retiring the orphaned Supabase Auth account behind the scenes (see
// handleRetireAuthAccount in wag-api/worker.js for why this can't be done
// client-side, and why it renames rather than hard-deletes). Best-effort:
// if it fails, the profile row is already anonymized either way, so we
// just warn rather than blocking the delete the admin already confirmed.
async function retireAuthAccount(authUserId) {
  if (!authUserId || !WORKER_URL) return { ok: false, error: 'not configured' };
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return { ok: false, error: 'no session' };
    const res = await fetch(`${WORKER_URL}/api/retire-auth-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ authUserId }),
    });
    const result = await res.json();
    return res.ok && !result.error ? { ok: true } : { ok: false, error: result.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteCustomer(id, name) {
  showLoading('Checking…');
  // Fix: a customer account can only be permanently deleted once it has
  // been suspended first — suspension alone never requires a zero balance,
  // but deletion always does, checked below.
  const { data: custRow } = await db.from('customers').select('status').eq('id', id).single();
  if (!custRow || custRow.status !== 'suspended') {
    hideLoading();
    alert(`Cannot delete ${name} — the account must be suspended before it can be permanently deleted.`);
    return;
  }
  const { data: balRows } = await db.from('plan_balances').select('balance').eq('customer_id', id);
  const totalBal = (balRows || []).reduce((s, r) => s + Number(r.balance), 0);
  hideLoading();
  if (totalBal > 0) {
    alert(`Cannot delete ${name} — they still have ${fmt(totalBal)} in their plans.\nResolve the balance first.`);
    return;
  }
  if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
  showLoading('Deleting…');
  const { data: custAuthRow } = await db.from('customers').select('auth_user_id').eq('id', id).single();
  // Fix: transactions/disbursements already snapshot the customer's name
  // at the moment they were created (see sql/002) — so overwriting the
  // name here no longer erases it from historical/transactional records,
  // receipts, or the audit log. Only this LIVE profile becomes [DELETED].
  // Fix: also anonymize email — it was left untouched before, so its
  // UNIQUE constraint permanently blocked ever re-registering this same
  // phone number again (a new signup generates the same deterministic
  // synthetic email for that phone, colliding with this old row's).
  await db.from('customers').update({ status: 'deleted', first_name: '[DELETED]', last_name: '', phone: 'del_' + id, email: 'del_' + id + '@wagthrift.retired' }).eq('id', id);
  // Fix: also retire the orphaned Auth account (never removed before),
  // which used to permanently block this phone number from ever being
  // reused — signUp() would fail with Supabase's own "User already
  // registered" error with no visible link back to this deletion.
  const retireResult = await retireAuthAccount(custAuthRow?.auth_user_id);
  await audit('delete', `Admin permanently deleted customer ${name} (${id})`);
  hideLoading();
  if (!retireResult.ok) alert(`${name} was deleted, but their phone number may not be reusable yet (${retireResult.error || 'could not reach the server'}). Contact your developer if re-registering this phone number fails.`);
  await renderCustomersPage();
}

// ═══════════════════════════════════════════════
// AGENTS (admin/representatives.html)
// ═══════════════════════════════════════════════
async function getAgentReliability(repId) {
  const { data } = await db.from('fraud_flags').select('severity').eq('user_id', repId).eq('resolved', false);
  let score = 100;
  (data || []).forEach(f => { score -= f.severity === 'medium' ? 8 : f.severity === 'high' ? 15 : 3; });
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function renderAgentsPage() {
  // Fix: same issue as renderCustomersPage() — deleted agents used to
  // still show up here with a misleading "Suspend" button.
  const { data: reps } = await db.from('representatives').select('*').neq('status', 'deleted').order('created_at', { ascending: false });
  const el = document.getElementById('agentsPageList');
  if (!el) return;
  if (!reps?.length) { el.innerHTML = '<div class="empty-state">No agents registered</div>'; return; }
  const agentRows = await Promise.all((reps || []).map(async r => {
    const reliability = await getAgentReliability(r.id);
    const isSuspended = r.status === 'suspended';
    const statusLabel = isSuspended ? '<span style="background:rgba(220,38,38,.15);color:#fca5a5;font-size:9px;font-weight:800;padding:2px 7px;border-radius:50px;letter-spacing:.5px;margin-left:6px;">SUSPENDED</span>' : '';
    const actionBtns = isSuspended
      ? `<button class="btn btn-green" onclick="restoreAgent('${r.id}','${r.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.51"/></svg>Restore</button>
         <button class="btn btn-red" onclick="deleteAgent('${r.id}','${r.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;margin-left:4px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>Delete</button>`
      : `<button class="btn btn-ghost" onclick="suspendAgent('${r.id}','${r.first_name}')" style="font-size:10px;padding:4px 10px;margin-top:4px;">Suspend</button>`;
    const reliabilityColor = reliability >= 80 ? 'var(--green)' : reliability >= 60 ? 'var(--yellow)' : 'var(--red)';
    return `<div class="agent-row">
      <div>
        <div class="agent-row-name">${r.first_name} ${r.last_name}${statusLabel}</div>
        <div class="agent-row-sub">${(r.phone || '').replace('+234', '0')} · Since ${fmtDate(r.created_at)}</div>
        <div style="font-size:11px;margin-top:3px;">Reliability: <span style="color:${reliabilityColor};font-weight:800;">${reliability}%</span></div>
      </div>
      <div class="agent-row-right">
        <div class="agent-row-id">${r.rep_id}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${actionBtns}</div>
      </div>
    </div>`;
  }));
  el.innerHTML = `<div class="section-card"><div style="font-size:11px;color:var(--sub);margin-bottom:11px;">${reps.length} agent(s)</div>` + agentRows.join('') + '</div>';
}

async function suspendAgent(id, name) {
  showLoading('Suspending…');
  const { error } = await db.from('representatives').update({ status: 'suspended' }).eq('id', id);
  if (error) {
    hideLoading();
    if (error.message && error.message.includes('status')) showMigrationAlert('representatives');
    else alert('Error: ' + error.message);
    return;
  }
  await audit('flag', `Admin suspended agent ${name} (${id})`);
  hideLoading();
  await renderAgentsPage();
}

async function restoreAgent(id, name) {
  showLoading('Restoring…');
  const { error } = await db.from('representatives').update({ status: 'active' }).eq('id', id);
  if (error) {
    hideLoading();
    if (error.message && error.message.includes('status')) showMigrationAlert('representatives');
    else alert('Error: ' + error.message);
    return;
  }
  await audit('flag', `Admin restored agent ${name} (${id})`);
  hideLoading();
  await renderAgentsPage();
}

async function deleteAgent(id, name) {
  showLoading('Checking…');
  const { data: repRow } = await db.from('representatives').select('status').eq('id', id).single();
  hideLoading();
  if (!repRow || repRow.status !== 'suspended') {
    alert(`Cannot delete ${name} — the account must be suspended before it can be permanently deleted.`);
    return;
  }
  if (!confirm(`Permanently delete agent ${name}? This cannot be undone.`)) return;
  showLoading('Deleting…');
  const { data: repAuthRow } = await db.from('representatives').select('auth_user_id').eq('id', id).single();
  // Fix: transactions already snapshot the agent's name at the moment
  // they were created (see sql/002), so this no longer erases the agent's
  // name from historical/transactional records or the audit log.
  // Fix: also anonymize email — same reasoning as deleteCustomer() above.
  await db.from('representatives').update({ status: 'deleted', first_name: '[DELETED]', last_name: '', phone: 'del_' + id, email: 'del_' + id + '@wagthrift.retired' }).eq('id', id);
  // Fix: also retire the orphaned Auth account — see retireAuthAccount()
  // above and handleRetireAuthAccount in wag-api/worker.js for why this
  // couldn't be done client-side and why it used to block phone reuse.
  const retireResult = await retireAuthAccount(repAuthRow?.auth_user_id);
  await audit('delete', `Admin permanently deleted agent ${name} (${id})`);
  hideLoading();
  if (!retireResult.ok) alert(`${name} was deleted, but their phone number may not be reusable yet (${retireResult.error || 'could not reach the server'}). Contact your developer if re-registering this phone number fails.`);
  await renderAgentsPage();
}

// ═══════════════════════════════════════════════
// SEARCH (admin/users.html)
// ═══════════════════════════════════════════════
let adminSubSearch = 'customer';
function setSearchSub(type) {
  adminSubSearch = type;
  document.querySelectorAll('[id^="ssub-"]').forEach(b => b.style.background = '');
  document.getElementById('ssub-' + type).style.background = 'rgba(255,186,9,.12)';
  document.getElementById('adminSearchInp').placeholder = type === 'customer' ? 'Enter phone (e.g. 08012345678)' : 'Enter Agent ID (e.g. 234567)';
  setMsg('adminSearchResult', '');
}

async function adminDoSearch() {
  if (!db) return;
  const val = document.getElementById('adminSearchInp').value.trim();
  if (!val) { setMsg('adminSearchResult', '<div class="msg-err">Please enter a value</div>'); return; }
  showLoading('Searching…');
  if (adminSubSearch === 'customer') {
    const normPh = normPhone(val);
    let { data: cust } = await db.from('customers').select('*').eq('phone', normPh).single();
    if (!cust) { const { data: c2 } = await db.from('customers').select('*').ilike('phone', '%' + val.replace(/\D/g, '').slice(-9)); cust = c2?.[0] || null; }
    if (!cust) { hideLoading(); setMsg('adminSearchResult', '<div class="msg-err">Customer not found</div>'); return; }
    const { data: plans } = await db.from('plan_balances').select('*').eq('customer_id', cust.id).neq('status', 'deleted');
    const planCards = await Promise.all((plans || []).map(async p => {
      const { data: txs } = await db.from('transactions').select('*').eq('plan_id', p.plan_id).order('created_at', { ascending: false }).limit(5);
      const { data: planExtra } = await db.from('plans').select('regular_contribution,status').eq('id', p.plan_id).single();
      const regContrib = planExtra?.regular_contribution || 0;
      const realStatus = planExtra?.status || p.status;
      const statusColor = realStatus === 'closed' ? 'var(--red)' : realStatus === 'active' ? 'var(--green)' : 'var(--orange)';
      return `<div class="adr-plan-card"><div class="adr-plan-header"><div><div class="adr-plan-name">${p.name}</div></div><div><div class="adr-plan-bal">${fmt(p.balance)}</div><div class="adr-plan-of" style="color:${statusColor};font-weight:700;font-size:11px;text-transform:uppercase;">${realStatus}</div></div></div><div class="adr-plan-meta">${p.frequency?.toLowerCase() || ''} · Regular: ${regContrib > 0 ? fmt(regContrib) : 'Not set'}</div>${(txs || []).map(tx => { const isIn = tx.type === 'deposit' || tx.type === 'opening'; return `<div class="adr-plan-tx"><span class="adr-tx-info">${fmtDate(tx.created_at)} · ${isIn ? 'deposit' : 'payout'}</span><span class="${isIn ? 'adr-tx-green' : 'adr-tx-red'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</span></div>`; }).join('')}</div>`;
    }));
    hideLoading();
    setMsg('adminSearchResult', `<div class="adr-profile"><div><div class="adr-name">${cust.first_name} ${cust.last_name}</div><div class="adr-phone">${(cust.phone || '').replace('+234', '0')}</div><div class="adr-since">Member since ${fmtDate(cust.created_at)}</div></div><span class="adr-cust-badge">CUSTOMER</span></div>${planCards.join('') || '<div class="empty-state">No plans yet</div>'}`);
  } else {
    const { data: rep } = await db.from('representatives').select('*').eq('rep_id', val).single();
    if (!rep) { hideLoading(); setMsg('adminSearchResult', '<div class="msg-err">Agent not found</div>'); return; }
    const { data: allRepTx } = await db.from('transactions').select('*').eq('agent_id', rep.id).order('created_at', { ascending: false });
    const colTx = (allRepTx || []).filter(t => t.type === 'deposit' || t.type === 'opening');
    const payTx = (allRepTx || []).filter(t => t.type === 'payout');
    const totalCol = colTx.reduce((s, t) => s + Number(t.amount), 0);
    const totalPay = payTx.reduce((s, t) => s + Number(t.amount), 0);
    const totalTxCount = (allRepTx || []).length;
    const reliability = await getAgentReliability(rep.id);
    const reliabilityColor = reliability >= 80 ? 'var(--green)' : reliability >= 60 ? 'var(--yellow)' : 'var(--red)';
    const txRows = (allRepTx || []).slice(0, 20).map(tx => {
      const isIn = tx.type === 'deposit' || tx.type === 'opening';
      return `<div class="adr-plan-tx"><span class="adr-tx-info">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)} · ${tx.type}</span><span class="${isIn ? 'adr-tx-green' : 'adr-tx-red'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</span></div>`;
    }).join('');
    hideLoading();
    setMsg('adminSearchResult', `<div class="section-card">
      <div class="adr-name" style="margin-bottom:4px;">${rep.first_name} ${rep.last_name}</div>
      <div class="adr-phone">${(rep.phone || '').replace('+234', '0')}</div>
      <div class="adr-since">Agent ID: ${rep.rep_id} · Since ${fmtDate(rep.created_at)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px;">
        <div style="background:rgba(5,150,105,.1);border-radius:9px;padding:10px;text-align:center;min-width:0;overflow:hidden;"><div style="font-size:10px;color:var(--sub);margin-bottom:4px;white-space:nowrap;">Total Collected</div><div style="font-size:clamp(10px,3vw,15px);font-weight:800;color:var(--green);word-break:break-all;line-height:1.2;">${fmt(totalCol)}</div></div>
        <div style="background:rgba(220,38,38,.1);border-radius:9px;padding:10px;text-align:center;min-width:0;overflow:hidden;"><div style="font-size:10px;color:var(--sub);margin-bottom:4px;white-space:nowrap;">Total Paid Out</div><div style="font-size:clamp(10px,3vw,15px);font-weight:800;color:var(--red);word-break:break-all;line-height:1.2;">${fmt(totalPay)}</div></div>
        <div style="background:rgba(255,186,9,.08);border-radius:9px;padding:10px;text-align:center;min-width:0;overflow:hidden;"><div style="font-size:10px;color:var(--sub);margin-bottom:4px;">Reliability</div><div style="font-size:clamp(10px,3vw,15px);font-weight:800;color:${reliabilityColor};">${reliability}%</div><div style="font-size:9px;color:var(--sub);">${totalTxCount} tx</div></div>
      </div>
      ${txRows ? `<div style="margin-top:12px;"><div style="font-size:11px;font-weight:700;color:var(--yellow);margin-bottom:8px;">Recent Transactions (last 20)</div>${txRows}</div>` : ''}
    </div>`);
  }
}

// ═══════════════════════════════════════════════
// ANALYTICS (admin/analytics.html)
// ═══════════════════════════════════════════════
async function renderAnalytics() {
  if (!db) return;
  const days = []; const today = new Date();
  for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(d); }
  const weekStart = new Date(days[0]); weekStart.setHours(0, 0, 0, 0);

  const [{ data: totals }, { count: custCnt }, { count: repCnt }, { count: activePlanCnt }, { count: flagCnt }, { data: weekDeps }, { data: leaderboard }] = await Promise.all([
    db.rpc('admin_transaction_totals'),
    db.from('customers').select('*', { count: 'exact', head: true }),
    db.from('representatives').select('*', { count: 'exact', head: true }),
    db.from('plans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('fraud_flags').select('*', { count: 'exact', head: true }).eq('resolved', false),
    // Only the last 7 days are needed for the chart below — no reason to
    // pull the entire transaction history just to plot one week of bars.
    db.from('transactions').select('amount,created_at').in('type', ['deposit', 'opening']).gte('created_at', weekStart.toISOString()),
    db.rpc('admin_agent_leaderboard', { p_limit: 5 }),
  ]);
  const totalVol = totals?.[0]?.total_deposits || 0;
  const totalPay = totals?.[0]?.total_payouts || 0;

  document.getElementById('analyticsGrid').innerHTML = `
    <div class="ov-card green"><div class="ov-lbl">Total Volume</div><div class="ov-val">${fmt(totalVol)}</div><div class="ov-sub">all deposits</div></div>
    <div class="ov-card red"><div class="ov-lbl">Total Payouts</div><div class="ov-val">${fmt(totalPay)}</div><div class="ov-sub">disbursed</div></div>
    <div class="ov-card"><div class="ov-lbl">Active Plans</div><div class="ov-val">${activePlanCnt || 0}</div><div class="ov-sub">in progress</div></div>
    <div class="ov-card orange"><div class="ov-lbl">Active Flags</div><div class="ov-val">${flagCnt || 0}</div><div class="ov-sub">unresolved</div></div>
    <div class="ov-card"><div class="ov-lbl">Customers</div><div class="ov-val">${custCnt || 0}</div><div class="ov-sub">registered</div></div>
    <div class="ov-card"><div class="ov-lbl">Field Agents</div><div class="ov-val">${repCnt || 0}</div><div class="ov-sub">active</div></div>`;

  const dayTotals = days.map(d => { const ds = d.toDateString(); return (weekDeps || []).filter(t => new Date(t.created_at).toDateString() === ds).reduce((s, t) => s + Number(t.amount), 0); });
  const maxAmt = Math.max(...dayTotals, 1);
  document.getElementById('barChart').innerHTML = dayTotals.map((amt, i) => `<div class="bar-item"><div class="bar" style="height:${Math.max(4, Math.round((amt / maxAmt) * 70))}px;" title="${fmt(amt)}"></div><div class="bar-label">${days[i].toLocaleDateString('en', { weekday: 'short' })}</div></div>`).join('');

  document.getElementById('topAgentsList').innerHTML = (leaderboard || []).length
    ? leaderboard.map((r, i) => `<div class="agent-row"><div><span style="color:var(--yellow);font-weight:800;margin-right:7px;">#${i + 1}</span><span style="font-size:13px;">${r.first_name} ${r.last_name}</span><div style="color:var(--sub);font-size:10px;margin-top:2px;">ID: ${r.rep_id}</div></div><div style="color:var(--green);font-weight:700;font-size:13px;">${fmt(r.total)}</div></div>`).join('')
    : '<div class="empty-state">No agents yet</div>';
}

// ═══════════════════════════════════════════════
// FRAUD FLAGS (admin/analytics.html)
// ═══════════════════════════════════════════════
// fraud_flags.user_id means a different thing depending on `type` — there's
// no explicit role column on the table, so the type tells us which table
// (and which key) to look the account up by:
//   LARGE_COLLECTION      → user_id is a representatives.id
//   EXCESS_WITHDRAWAL     → user_id is a customers.id
//   FAILED_PIN_ATTEMPTS   → user_id is actually a raw phone string (see
//                            checkFailedPin in auth.js), not a foreign key —
//                            look up customers by phone instead, and it may
//                            not resolve to any real account at all (e.g. a
//                            mistyped number on the login screen).
async function renderFraudFlags() {
  const { data: flags } = await db.from('fraud_flags').select('*').eq('resolved', false).order('created_at', { ascending: false });
  const el = document.getElementById('fraudFlagsList');
  if (!el) return;
  if (!flags?.length) { el.innerHTML = '<div class="empty-state">No active fraud flags</div>'; return; }
  const cards = await Promise.all(flags.map(renderFraudFlagCard));
  el.innerHTML = cards.join('');
}

async function renderFraudFlagCard(f) {
  const desc = (f.description || '').replace(/emergency/gi, 'withdrawal').replace(/EXCESS_EMERGENCY/g, 'EXCESS_WITHDRAWAL');
  const type = (f.type || '').replace(/emergency/gi, 'withdrawal').replace(/EXCESS_EMERGENCY/g, 'EXCESS_WITHDRAWAL');

  let accountHtml;
  try {
    if (type === 'LARGE_COLLECTION') accountHtml = await buildAgentFlagContext(f.user_id);
    else if (type === 'EXCESS_WITHDRAWAL') accountHtml = await buildCustomerFlagContext(f.user_id, true);
    else if (type === 'FAILED_PIN_ATTEMPTS') {
      const { data: cust } = await db.from('customers').select('id').eq('phone', f.user_id).maybeSingle();
      accountHtml = cust
        ? await buildCustomerFlagContext(cust.id, false)
        : `<div class="ff-not-found">No account matches ${f.user_id} — likely a mistyped number at login, not a real customer to act on.</div>`;
    } else {
      accountHtml = `<div class="ff-not-found">Unrecognized flag type — no automatic account lookup available for "${f.type}".</div>`;
    }
  } catch (e) {
    accountHtml = `<div class="ff-not-found">Couldn't load account details (${e.message || 'unknown error'}).</div>`;
  }

  return `<div class="fraud-flag-card"><div class="ff-header"><span class="ff-type">${type.replace(/_/g, ' ')} · ${(f.severity||'').toUpperCase()}</span><span class="ff-time">${fmtDate(f.created_at)}</span></div><div class="ff-desc">${desc}</div>${accountHtml}<div class="ff-actions"><button class="btn btn-green" style="font-size:12px;padding:7px 12px;" onclick="resolveFlag('${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Mark Resolved</button></div></div>`;
}

async function buildCustomerFlagContext(custId, withEvidence) {
  const { data: c } = await db.from('customers').select('*').eq('id', custId).maybeSingle();
  if (!c) return '<div class="ff-not-found">Customer account not found — may have been deleted.</div>';
  const isSuspended = c.status === 'suspended';
  const statusTag = isSuspended ? '<span class="ff-status-tag">SUSPENDED</span>' : '';
  const actionBtn = isSuspended
    ? `<button class="btn btn-green" onclick="suspendFlagAccount('customer','restore','${c.id}','${(c.first_name||'').replace(/'/g,"\\'")}')" style="font-size:10px;padding:5px 11px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.51"/></svg>Restore</button>`
    : `<button class="btn btn-red" onclick="suspendFlagAccount('customer','suspend','${c.id}','${(c.first_name||'').replace(/'/g,"\\'")}')" style="font-size:10px;padding:5px 11px;">Suspend Account</button>`;

  let evidence = '';
  if (withEvidence) {
    const { data: withdrawals } = await db.from('disbursements').select('*').eq('customer_id', custId).eq('type', 'withdrawal').order('requested_at', { ascending: false }).limit(5);
    if (withdrawals?.length) {
      evidence = `<div class="ff-evidence"><div class="ff-evidence-title">Recent withdrawal requests</div>` +
        withdrawals.map(w => `<div class="ff-evidence-row"><span>${fmt(w.amount)}</span><span>${(w.status || 'pending').toUpperCase()} · ${fmtDate(w.requested_at)}</span></div>`).join('') +
        `</div>`;
    }
  }

  return `<div class="ff-account"><div class="ff-account-row"><div><div class="ff-account-name">${c.first_name} ${c.last_name}<span class="ff-role-tag">CUSTOMER</span>${statusTag}</div><div class="ff-account-sub">${(c.phone || '').replace('+234', '0')} · Joined ${fmtDate(c.created_at)}</div></div><div>${actionBtn}</div></div>${evidence}</div>`;
}

async function buildAgentFlagContext(agentId) {
  const { data: r } = await db.from('representatives').select('*').eq('id', agentId).maybeSingle();
  if (!r) return '<div class="ff-not-found">Agent account not found — may have been deleted.</div>';
  const reliability = await getAgentReliability(r.id);
  const reliabilityColor = reliability >= 80 ? 'var(--green)' : reliability >= 60 ? 'var(--yellow)' : 'var(--red)';
  const isSuspended = r.status === 'suspended';
  const statusTag = isSuspended ? '<span class="ff-status-tag">SUSPENDED</span>' : '';
  const actionBtn = isSuspended
    ? `<button class="btn btn-green" onclick="suspendFlagAccount('agent','restore','${r.id}','${(r.first_name||'').replace(/'/g,"\\'")}')" style="font-size:10px;padding:5px 11px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;display:inline-block;vertical-align:middle;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.51"/></svg>Restore</button>`
    : `<button class="btn btn-red" onclick="suspendFlagAccount('agent','suspend','${r.id}','${(r.first_name||'').replace(/'/g,"\\'")}')" style="font-size:10px;padding:5px 11px;">Suspend Account</button>`;

  return `<div class="ff-account"><div class="ff-account-row"><div><div class="ff-account-name">${r.first_name} ${r.last_name}<span class="ff-role-tag">AGENT</span>${statusTag}</div><div class="ff-account-sub">${r.rep_id} · ${(r.phone || '').replace('+234', '0')} · Reliability <span style="color:${reliabilityColor};font-weight:800;">${reliability}%</span></div></div><div>${actionBtn}</div></div></div>`;
}

async function suspendFlagAccount(role, action, id, name) {
  if (role === 'customer') { action === 'suspend' ? await suspendCustomer(id, name) : await restoreCustomer(id, name); }
  else { action === 'suspend' ? await suspendAgent(id, name) : await restoreAgent(id, name); }
  await renderFraudFlags();
}

async function resolveFlag(id) {
  await db.from('fraud_flags').update({ resolved: true }).eq('id', id);
  await renderFraudFlags();
  await renderAnalytics();
}

// ═══════════════════════════════════════════════
// TOKENS (admin/representatives.html)
// ═══════════════════════════════════════════════
async function adminGenToken() {
  if (!db) return;
  const tok = genToken();
  const { error } = await db.from('activation_tokens').insert({ token: tok });
  if (error) { setMsg('genTokMsg', `<div class="msg-err">${error.message}</div>`); return; }
  await audit('login', `Generated activation token: ${tok}`);
  setMsg('genTokMsg', `<div class="msg-ok">Generated: <strong style="font-family:monospace;">${tok}</strong></div>`);
  await renderTokensList();
}

async function renderTokensList() {
  const { data: toks } = await db.from('activation_tokens').select('*').order('generated_at', { ascending: false });
  const el = document.getElementById('adminTokList');
  if (!el) return;
  if (!toks?.length) { el.innerHTML = '<div class="empty-state">No tokens yet</div>'; return; }
  el.innerHTML = toks.map(t => `<div class="tok-row"><div class="tok-val">${t.token}</div><span class="${t.used ? 'tok-used' : 'tok-active'}">${t.used ? 'USED' : 'ACTIVE'}</span></div>`).join('');
}

// ═══════════════════════════════════════════════
// AUDIT LOG (admin/settings.html)
// ═══════════════════════════════════════════════
let allAuditLogs = [];

const AUDIT_PAGE_SIZE = 100;
let _auditPageOffset = 0;
let _auditHasMore = true;

async function renderAuditLog() {
  _auditPageOffset = 0;
  allAuditLogs = [];
  const { data: logs } = await db.from('audit_log').select('*').order('created_at', { ascending: false }).range(0, AUDIT_PAGE_SIZE - 1);
  allAuditLogs = logs || [];
  _auditHasMore = (logs || []).length === AUDIT_PAGE_SIZE;
  _auditPageOffset = allAuditLogs.length;
  renderAuditEntries(allAuditLogs);
}

async function loadMoreAuditLog() {
  const btn = document.getElementById('auditLoadMoreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  const { data: logs } = await db.from('audit_log').select('*').order('created_at', { ascending: false }).range(_auditPageOffset, _auditPageOffset + AUDIT_PAGE_SIZE - 1);
  _auditHasMore = (logs || []).length === AUDIT_PAGE_SIZE;
  _auditPageOffset += (logs || []).length;
  allAuditLogs = [...allAuditLogs, ...(logs || [])];
  renderAuditEntries(allAuditLogs);
}

function filterAuditLog() {
  const q = (document.getElementById('auditSearchInp')?.value || '').toLowerCase().trim();
  if (!q) { renderAuditEntries(allAuditLogs); return; }
  renderAuditEntries(allAuditLogs.filter(e => e.description?.toLowerCase().includes(q) || e.action?.toLowerCase().includes(q) || e.user_role?.toLowerCase().includes(q)));
}

function renderAuditRows(containerId, logs) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!logs?.length) { el.innerHTML = '<div class="empty-state">No entries</div>'; return; }
  el.innerHTML = logs.map(e => `<div class="audit-item"><div class="audit-action ${e.action}">${e.action?.toUpperCase()}${e.amount ? ' — ' + fmt(e.amount) : ''}</div><div class="audit-desc">${e.description}</div><div class="audit-time">${fmtDate(e.created_at)} · ${fmtTime(e.created_at)} · ${e.user_role}</div></div>`).join('');
}

function renderAuditEntries(logs) {
  renderAuditRows('auditLogList', logs);
  const el = document.getElementById('auditLogList');
  if (el && _auditHasMore && logs.length) {
    el.insertAdjacentHTML('beforeend', '<button id="auditLoadMoreBtn" class="btn btn-outline" onclick="loadMoreAuditLog()" style="margin-top:10px;">Load more</button>');
  }
}

// ═══════════════════════════════════════════════
// SETTINGS (admin/settings.html)
// ═══════════════════════════════════════════════
let sessionLog = [];
function renderSecurityLog() {
  const el = document.getElementById('securityLog');
  if (!el) return;
  if (!sessionLog.length) { el.innerHTML = '<div class="empty-state">No events this session</div>'; return; }
  el.innerHTML = sessionLog.map(e => `<div class="sec-log-item"><div><div class="sec-log-left">Admin portal ${e.type === 'ok' ? 'login' : 'failed login attempt'}</div><div class="sec-log-time">${e.time}</div></div><span class="sec-log-badge ${e.type === 'ok' ? 'ok' : 'fail'}">${e.type === 'ok' ? 'SUCCESS' : 'FAILED'}</span></div>`).join('');
}

async function changeAdminPin() {
  const cur = document.getElementById('settCurrentPin').value;
  const np = document.getElementById('settNewPin').value;
  const cp = document.getElementById('settConfirmPin').value;
  if (!cur || !np) { setMsg('settMsg', '<div class="msg-err">Fill in all fields</div>'); return; }
  if (np.length < 8) { setMsg('settMsg', '<div class="msg-err">New password must be at least 8 characters</div>'); return; }
  if (np !== cp) { setMsg('settMsg', '<div class="msg-err">New passwords do not match</div>'); return; }
  showLoading('Verifying…');
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user?.email) { hideLoading(); setMsg('settMsg', '<div class="msg-err">Session expired. Please sign in again.</div>'); return; }
  const { error: verifyErr } = await db.auth.signInWithPassword({ email: session.user.email, password: cur });
  if (verifyErr) { hideLoading(); setMsg('settMsg', '<div class="msg-err">Current password is incorrect</div>'); return; }
  const { error: updateErr } = await db.auth.updateUser({ password: np });
  hideLoading();
  if (updateErr) { setMsg('settMsg', `<div class="msg-err">${updateErr.message}</div>`); return; }
  await audit('login', 'Admin changed their password');
  setMsg('settMsg', '<div class="msg-ok">Password updated successfully.</div>');
  ['settCurrentPin', 'settNewPin', 'settConfirmPin'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
}

// ═══════════════════════════════════════════════
// INVITE NEW ADMIN — only callable by an existing admin (is_admin() check
// happens server-side in create_admin_account).
// ═══════════════════════════════════════════════
async function inviteNewAdmin() {
  const fn = document.getElementById('newAdminFn')?.value?.trim();
  const ln = document.getElementById('newAdminLn')?.value?.trim();
  const em = document.getElementById('newAdminEmail')?.value?.trim();
  const pw = document.getElementById('newAdminPw')?.value?.trim();
  if (!fn || !ln || !em || !pw) { setMsg('inviteAdminMsg', '<div class="msg-err">Fill in all fields</div>'); return; }
  if (pw.length < 8) { setMsg('inviteAdminMsg', '<div class="msg-err">Password must be at least 8 characters</div>'); return; }
  showLoading('Creating admin account…');
  // Sign up the new admin's Auth account. Note: this will sign the CURRENT
  // browser session in as the new user temporarily (Supabase JS client
  // behavior) — we immediately restore the original admin session after.
  const { data: { session: originalSession } } = await db.auth.getSession();
  const { data: signUpData, error: signUpErr } = await db.auth.signUp({ email: em, password: pw });
  if (signUpErr || !signUpData?.user) {
    hideLoading();
    setMsg('inviteAdminMsg', `<div class="msg-err">${signUpErr?.message || 'Could not create account'}</div>`);
    return;
  }
  const { data: result, error: rpcErr } = await db.rpc('create_admin_account', {
    p_auth_user_id: signUpData.user.id, p_first_name: fn, p_last_name: ln, p_email: em, p_bootstrap: false
  });
  // Restore the original admin's session (signUp may have switched the
  // active session to the new user)
  if (originalSession) await db.auth.setSession({ access_token: originalSession.access_token, refresh_token: originalSession.refresh_token });
  hideLoading();
  if (rpcErr || result?.ok === false) {
    setMsg('inviteAdminMsg', `<div class="msg-err">${result?.error || rpcErr?.message || 'Failed to create admin'}</div>`);
    return;
  }
  setMsg('inviteAdminMsg', `<div class="msg-ok">Admin account created for ${fn} ${ln}. They can now sign in with ${em}.</div>`);
  ['newAdminFn', 'newAdminLn', 'newAdminEmail', 'newAdminPw'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  await renderAdminsList();
}

// ═══════════════════════════════════════════════
// TWO-FACTOR AUTHENTICATION (Settings page)
// Uses Supabase Auth's built-in MFA — this app never sees or stores the
// raw secret; Supabase generates it, shows the QR code, and verifies
// codes internally, upgrading the session to a real "aal2" JWT claim
// that is_admin() checks directly (see sql/007_admin_2fa.sql).
// ═══════════════════════════════════════════════

async function get2FAStatus() {
  const { data, error } = await db.auth.mfa.listFactors();
  if (error) return { enrolled: false };
  const factor = data?.totp?.find(f => f.status === 'verified');
  return { enrolled: !!factor, factorId: factor?.id || null };
}

async function render2FASection() {
  const el = document.getElementById('twoFASection');
  if (!el) return;
  const status = await get2FAStatus();
  if (status.enrolled) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;"></span>
        <span style="font-weight:700;color:var(--green);">2FA is turned on</span>
      </div>
      <div style="font-size:12px;color:var(--sub);margin-bottom:14px;">
        You'll be asked for a code from your authenticator app every time you sign in.
      </div>
      <button class="btn btn-outline" onclick="disable2FA('${status.factorId}')">Turn off 2FA</button>`;
  } else {
    el.innerHTML = `
      <div style="font-size:12px;color:var(--sub);margin-bottom:14px;">
        Add an extra layer of security — after your password, you'll also need a code from an
        authenticator app (like Google Authenticator or Authy) to sign in.
      </div>
      <button class="btn btn-yellow" onclick="start2FAEnrollment()">Set up 2FA</button>`;
  }
}

async function start2FAEnrollment() {
  showLoading('Setting up…');
  const { data, error } = await db.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator App ' + Date.now() });
  hideLoading();
  if (error) { alert('Could not start 2FA setup. Please try again.'); return; }

  window._enrollFactorId = data.id;
  document.getElementById('mfaQrImg').src = data.totp.qr_code;
  document.getElementById('mfaManualSecret').textContent = data.totp.secret;
  document.getElementById('mfaEnrollCodeInp').value = '';
  setMsg('mfaEnrollMsg', '');
  showModal('mfaEnrollModal');
}

async function confirm2FAEnrollment() {
  const code = document.getElementById('mfaEnrollCodeInp').value.trim();
  if (!/^\d{6}$/.test(code)) { setMsg('mfaEnrollMsg', '<div class="msg-err">Enter the 6-digit code from your authenticator app</div>'); return; }

  showLoading('Confirming…');
  const { data: challenge, error: challengeErr } = await db.auth.mfa.challenge({ factorId: window._enrollFactorId });
  if (challengeErr) { hideLoading(); setMsg('mfaEnrollMsg', '<div class="msg-err">Something went wrong. Please try again.</div>'); return; }

  const { error: verifyErr } = await db.auth.mfa.verify({ factorId: window._enrollFactorId, challengeId: challenge.id, code });
  hideLoading();
  if (verifyErr) {
    setMsg('mfaEnrollMsg', '<div class="msg-err">Incorrect code. Please try again.</div>');
    return;
  }

  closeModal('mfaEnrollModal');
  await audit('flag', 'Admin enabled two-factor authentication');
  await render2FASection();
  alert('2FA is now turned on. You\'ll be asked for a code the next time you sign in.');
}

async function disable2FA(factorId) {
  if (!confirm('Turn off two-factor authentication? Your account will only be protected by your password.')) return;
  showLoading('Turning off 2FA…');
  const { error } = await db.auth.mfa.unenroll({ factorId });
  hideLoading();
  if (error) { alert('Could not turn off 2FA. Please try again.'); return; }
  await audit('flag', 'Admin disabled two-factor authentication');
  await render2FASection();
}


async function renderAdminsList() {
  const el = document.getElementById('adminsList');
  if (!el) return;
  const { data: admins } = await db.from('administrators').select('*').order('created_at', { ascending: true });
  if (!admins?.length) { el.innerHTML = '<div class="empty-state">No admins found</div>'; return; }
  const me = getAdminSession();
  el.innerHTML = admins.map(a => `<div class="agent-row"><div><div class="agent-row-name">${a.first_name} ${a.last_name}${a.id === me?.id ? ' <span style="color:var(--yellow);font-size:10px;">(you)</span>' : ''}</div><div class="agent-row-sub">${a.email}</div></div><div style="font-size:11px;color:${a.status === 'active' ? 'var(--green)' : 'var(--red)'};font-weight:700;text-transform:uppercase;">${a.status}</div></div>`).join('');
}

// ═══════════════════════════════════════════════
// ADMIN DIGEST RECIPIENTS — who gets the daily/weekly activity email.
// Managed here in Settings instead of a hardcoded GitHub secret, so any
// admin can add/remove recipients without touching code.
// ═══════════════════════════════════════════════
async function renderReportRecipients() {
  const el = document.getElementById('reportRecipientsList');
  if (!el) return;
  const { data: rows, error } = await db.from('report_recipients').select('*').order('added_at', { ascending: true });
  if (error) {
    el.innerHTML = `<div class="empty-state">Couldn't load the list. ${error.code === '42P01' ? 'This feature needs one more setup step — ask your developer to run the report_recipients database update.' : 'Please try again.'}</div>`;
    return;
  }
  if (!rows?.length) { el.innerHTML = '<div class="empty-state">No one added yet — reports won\'t go out until you add at least one email.</div>'; return; }
  const me = getAdminSession();
  el.innerHTML = rows.map(r => `
    <div class="agent-row">
      <div>
        <div class="agent-row-name">${r.label || r.email}</div>
        ${r.label ? `<div class="agent-row-sub">${r.email}</div>` : ''}
      </div>
      <button class="btn-sm btn-sm-ghost" onclick="removeReportRecipient('${r.id}','${(r.email || '').replace(/'/g, "\\'")}')">Remove</button>
    </div>`).join('');
}

async function addReportRecipient() {
  const emailInp = document.getElementById('newRecipientEmail');
  const labelInp = document.getElementById('newRecipientLabel');
  const email = emailInp.value.trim().toLowerCase();
  const label = labelInp.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMsg('recipientMsg', '<div class="msg-err">Please enter a valid email address</div>');
    return;
  }
  showLoading('Adding…');
  const { error } = await db.from('report_recipients').insert({ email, label: label || null });
  hideLoading();
  if (error) {
    console.error('Add recipient error:', error);
    let msg = 'Something went wrong. Please try again.';
    if (error.code === '23505') msg = 'That email is already on the list';
    else if (error.code === '42P01') msg = 'This feature needs one more setup step — ask your developer to run the report_recipients database update.';
    else if (error.message) msg = `${msg} (${error.code || 'no code'}: ${error.message})`;
    setMsg('recipientMsg', `<div class="msg-err">${msg}</div>`);
    return;
  }
  emailInp.value = ''; labelInp.value = '';
  setMsg('recipientMsg', '<div class="msg-ok">Added</div>');
  await renderReportRecipients();
}

async function removeReportRecipient(id, email) {
  if (!confirm(`Stop sending reports to ${email}?`)) return;
  showLoading('Removing…');
  await db.from('report_recipients').delete().eq('id', id);
  hideLoading();
  await renderReportRecipients();
}

async function sendDigestNow(reportType) {
  if (!WORKER_URL) {
    setMsg('sendNowMsg', '<div class="msg-err">This needs the Worker to be set up first — ask your developer.</div>');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) { setMsg('sendNowMsg', '<div class="msg-err">Please sign in again</div>'); return; }
  showLoading(reportType === 'weekly' ? 'Sending weekly report…' : 'Sending daily report…');
  try {
    const res = await fetch(`${WORKER_URL}/api/send-digest-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ report_type: reportType }),
    });
    const result = await res.json();
    hideLoading();
    if (!res.ok || result.error) {
      setMsg('sendNowMsg', `<div class="msg-err">${result.error || 'Could not send the report. Please try again.'}</div>`);
      return;
    }
    setMsg('sendNowMsg', `<div class="msg-ok">Sent to ${result.sentTo?.length || 0} recipient(s)</div>`);
  } catch (e) {
    hideLoading();
    setMsg('sendNowMsg', '<div class="msg-err">Could not reach the server. Please try again.</div>');
  }
}


async function deleteInactiveUsers() {
  if (!confirm('Remove all customers with no plans and no transactions? This cannot be undone.')) return;
  showLoading('Removing inactive users…');
  const { data: custs } = await db.from('customers').select('id');
  let removed = 0;
  for (const c of (custs || [])) {
    const { count: pc } = await db.from('plans').select('*', { count: 'exact', head: true }).eq('customer_id', c.id);
    const { count: tc } = await db.from('transactions').select('*', { count: 'exact', head: true }).eq('customer_id', c.id);
    if (!pc && !tc) {
      await db.from('customers').update({ status: 'deleted' }).eq('id', c.id);
      removed++;
    }
  }
  await audit('delete', `Removed ${removed} inactive users`);
  hideLoading();
  alert(`Removed ${removed} inactive user(s)`);
  await renderAnalytics();
}

// ═══════════════════════════════════════════════
// CONFIRM MODAL
// ═══════════════════════════════════════════════
let confirmOkHandler = () => {};
function showConfirm(title, msg, onOk) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  confirmOkHandler = () => { closeModal('confirmModal'); onOk(); };
  showModal('confirmModal');
}

// ═══════════════════════════════════════════════
// REAL-TIME & BADGES
// ═══════════════════════════════════════════════
let realtimeChannels = [];

async function updateBadges() {
  if (!db || !isAdminLoggedIn()) return;
  try {
    const [{ count: pdc }, { count: fdc }] = await Promise.all([
      db.from('disbursements').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('fraud_flags').select('*', { count: 'exact', head: true }).eq('resolved', false)
    ]);
    const disbBadge = document.getElementById('disbBadge');
    if (disbBadge) { disbBadge.style.display = pdc > 0 ? '' : 'none'; disbBadge.textContent = pdc || 0; }
    const flagBadge = document.getElementById('flagBadge');
    if (flagBadge) { flagBadge.style.display = fdc > 0 ? '' : 'none'; flagBadge.textContent = fdc || 0; }
    const ovEl = document.getElementById('ovPendingDisb');
    if (ovEl) ovEl.textContent = pdc || 0;
  } catch (e) { }
}

// Sets up Supabase realtime subscriptions so this page refreshes itself when
// relevant tables change. `currentPage` (set inline per admin page) determines
// which renderer to re-run.
function setupRealtimeListeners() {
  realtimeChannels.forEach(ch => { try { db.removeChannel(ch); } catch (e) { } });
  realtimeChannels = [];

  const onAny = async (table) => {
    await updateBadges();
    if (currentPage === 'overview') await renderOverview();
    else if (currentPage === 'disbursements' && table === 'disbursements') await renderDisbPage();
    else if (currentPage === 'customers' && table === 'customers') await renderCustomersPage();
    else if (currentPage === 'agents' && table === 'representatives') await renderAgentsPage();
    else if (currentPage === 'flags' && table === 'fraud_flags') await renderFraudFlags();
    else if (currentPage === 'auditlog' && table === 'audit_log') await renderAuditLog();
    else if (currentPage === 'analytics') await renderAnalytics();
  };

  const tables = ['disbursements', 'transactions', 'audit_log', 'fraud_flags', 'customers', 'representatives', 'plans'];
  tables.forEach(table => {
    const ch = db.channel('admin-rt-' + table)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => onAny(table))
      .subscribe();
    realtimeChannels.push(ch);
  });
}

function teardownRealtime() {
  realtimeChannels.forEach(ch => { try { db.removeChannel(ch); } catch (e) { } });
  realtimeChannels = [];
}
