// ═══════════════════════════════════════════════
// js/admin.js
// SUPER ADMIN PORTAL — AUTH & SESSION
// Kept completely separate from customer/representative auth (js/auth.js
// session helpers getUser/setUser are NOT used here — admin uses its own
// sessionStorage key 'wagAdmin', see getAdminSession/setAdminSession in auth.js).
// Depends on: js/supabase.js, js/utils.js, js/auth.js (load all three first)
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// ADMIN SESSION — fully isolated from customer/rep sessions (wagUser).
// Admin pages do NOT load js/auth.js.
// ═══════════════════════════════════════════════
function getAdminSession() { try { return JSON.parse(sessionStorage.getItem('wagAdmin')); } catch (e) { return null; } }
function setAdminSession(a) { sessionStorage.setItem('wagAdmin', JSON.stringify(a)); }
function clearAdminSession() { sessionStorage.removeItem('wagAdmin'); }

// Call at the top of every admin page (except admin/login.html).
function requireAdmin() {
  // Detect a customer/representative session present in this browser and
  // immediately reject — they are never allowed past this point, even on
  // admin/login.html, so a customer can't sit on the PIN screen and guess.
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

// ═══════════════════════════════════════════════
// ADMIN AUDIT LOG WRITER
// ═══════════════════════════════════════════════
async function audit(action, description, amount = null, planId = null) {
  if (!db) return;
  await db.from('audit_log').insert({ action, user_id: 'admin', user_role: 'super_admin', description, amount, plan_id: planId });
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

// Change this to a secure PIN. In production this should be validated server-side.
const ADMIN_PIN = 'WAGE2026';

let loginAttempts = 0;
let lockoutUntil = 0;
let currentAdminPin = ADMIN_PIN; // In production, this would be server-side

function isAdminLoggedIn() {
  const a = getAdminSession();
  return !!(a && a.loggedIn);
}

// Called from admin/login.html
async function doAdminLogin() {
  const btn = document.getElementById('loginBtn');
  const now = Date.now();
  if (now < lockoutUntil) { return; }

  btn.disabled = false;
  btn.textContent = 'Access Super Admin Portal';

  const pin = document.getElementById('adminPinInp').value;
  if (!pin) { setMsg('loginMsg', '<div class="msg-err">Please enter the Admin PIN</div>'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  await new Promise(r => setTimeout(r, 600));

  await auditLoginAttempt(pin === currentAdminPin);
  sessionLog.unshift({ type: pin === currentAdminPin ? 'ok' : 'fail', time: new Date().toLocaleString() });

  if (pin === currentAdminPin) {
    loginAttempts = 0;
    const adminSession = { loggedIn: true, loginTime: new Date().toISOString() };
    setAdminSession(adminSession);
    document.getElementById('adminPinInp').value = '';
    window.location.href = rootPath() + 'admin/dashboard.html';
  } else {
    loginAttempts++;
    if (loginAttempts >= 5) {
      lockoutUntil = Date.now() + 30000;
      showLockout(30);
      setMsg('loginMsg', '');
    } else {
      setMsg('loginMsg', `<div class="msg-err">Invalid PIN — ${5 - loginAttempts} attempt(s) remaining</div>`);
    }
    btn.disabled = false;
    btn.textContent = 'Access Super Admin Portal';
  }
  document.getElementById('adminPinInp').value = '';
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
    { count: cc }, { count: rc }, { data: allTx }, { count: planCnt }, { data: pendDisb }
  ] = await Promise.all([
    db.from('customers').select('*', { count: 'exact', head: true }),
    db.from('representatives').select('*', { count: 'exact', head: true }),
    db.from('transactions').select('amount,type'),
    db.from('plans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    // Show both pending AND reviewed here — admin can review or approve
    // directly from the Overview without navigating to the full Disbursements tab.
    db.from('disbursements').select('*,customers(first_name,last_name,phone)').in('status', ['pending', 'reviewed']).order('requested_at', { ascending: false }).limit(5)
  ]);

  const deps = (allTx || []).filter(t => t.type === 'deposit' || t.type === 'opening');
  const pays = (allTx || []).filter(t => t.type === 'payout');
  const totalDep = deps.reduce((s, t) => s + Number(t.amount), 0);
  const totalPay = pays.reduce((s, t) => s + Number(t.amount), 0);

  document.getElementById('ovCust').textContent = cc || 0;
  document.getElementById('ovReps').textContent = rc || 0;
  document.getElementById('ovDeposits').textContent = fmt(totalDep);
  document.getElementById('ovPayouts').textContent = fmt(totalPay);
  document.getElementById('ovPlans').textContent = planCnt || 0;

  const { count: pdc } = await db.from('disbursements').select('*', { count: 'exact', head: true }).in('status', ['pending', 'reviewed']);
  document.getElementById('ovPendingDisb').textContent = pdc || 0;
  const badge = document.getElementById('disbBadge');
  if (badge) { if (pdc > 0) { badge.style.display = ''; badge.textContent = pdc; } else badge.style.display = 'none'; }

  if (!pendDisb?.length) {
    document.getElementById('ovDisbList').innerHTML = '<div class="empty-state">No pending withdrawals</div>';
  } else {
    document.getElementById('ovDisbList').innerHTML = pendDisb.map(d => renderDisbCard(d, true)).join('');
  }

  const { count: flagCount } = await db.from('fraud_flags').select('*', { count: 'exact', head: true }).eq('resolved', false);
  const flagBadgeEl = document.getElementById('flagBadge');
  if (flagBadgeEl) { flagBadgeEl.style.display = flagCount > 0 ? '' : 'none'; flagBadgeEl.textContent = flagCount || 0; }

  const { data: auditRows } = await db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(10);
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

  const phone = (cust.phone || '').replace('+234', '0');

  return `<div class="disb-item">
    <div class="disb-header">
      <div>
        <div class="disb-name">${cust.first_name || 'Unknown'} ${cust.last_name || ''}</div>
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
  const { data: custs } = await db.from('customers').select('*').order('created_at', { ascending: false });
  allCustomers = custs || [];
  renderCustomersList(allCustomers);
}

function renderCustomersList(custs) {
  const el = document.getElementById('custPageList');
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

async function deleteCustomer(id, name) {
  const { data: balRows } = await db.from('plan_balances').select('balance').eq('customer_id', id);
  const totalBal = (balRows || []).reduce((s, r) => s + Number(r.balance), 0);
  if (totalBal > 0) {
    alert(`Cannot delete ${name} — they still have ${fmt(totalBal)} in their plans.\nResolve the balance first.`);
    return;
  }
  if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
  showLoading('Deleting…');
  await db.from('customers').update({ status: 'deleted', first_name: '[DELETED]', last_name: '', phone: 'del_' + id, pin_hash: 'x' }).eq('id', id);
  await audit('delete', `Admin permanently deleted customer ${name} (${id})`);
  hideLoading();
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
  const { data: reps } = await db.from('representatives').select('*').order('created_at', { ascending: false });
  const el = document.getElementById('agentsPageList');
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
  if (!confirm(`Permanently delete agent ${name}? This cannot be undone.`)) return;
  showLoading('Deleting…');
  await db.from('representatives').update({ status: 'deleted', first_name: '[DELETED]', last_name: '', phone: 'del_' + id, pin_hash: 'x' }).eq('id', id);
  await audit('delete', `Admin permanently deleted agent ${name} (${id})`);
  hideLoading();
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
  const { data: allTx } = await db.from('transactions').select('amount,type,created_at');
  const deps = (allTx || []).filter(t => t.type === 'deposit' || t.type === 'opening');
  const pays = (allTx || []).filter(t => t.type === 'payout');
  const totalVol = deps.reduce((s, t) => s + Number(t.amount), 0);
  const totalPay = pays.reduce((s, t) => s + Number(t.amount), 0);
  const { count: custCnt } = await db.from('customers').select('*', { count: 'exact', head: true });
  const { count: repCnt } = await db.from('representatives').select('*', { count: 'exact', head: true });
  const { count: activePlanCnt } = await db.from('plans').select('*', { count: 'exact', head: true }).eq('status', 'active');
  const { count: flagCnt } = await db.from('fraud_flags').select('*', { count: 'exact', head: true }).eq('resolved', false);

  document.getElementById('analyticsGrid').innerHTML = `
    <div class="ov-card green"><div class="ov-lbl">Total Volume</div><div class="ov-val">${fmt(totalVol)}</div><div class="ov-sub">all deposits</div></div>
    <div class="ov-card red"><div class="ov-lbl">Total Payouts</div><div class="ov-val">${fmt(totalPay)}</div><div class="ov-sub">disbursed</div></div>
    <div class="ov-card"><div class="ov-lbl">Active Plans</div><div class="ov-val">${activePlanCnt || 0}</div><div class="ov-sub">in progress</div></div>
    <div class="ov-card orange"><div class="ov-lbl">Active Flags</div><div class="ov-val">${flagCnt || 0}</div><div class="ov-sub">unresolved</div></div>
    <div class="ov-card"><div class="ov-lbl">Customers</div><div class="ov-val">${custCnt || 0}</div><div class="ov-sub">registered</div></div>
    <div class="ov-card"><div class="ov-lbl">Field Agents</div><div class="ov-val">${repCnt || 0}</div><div class="ov-sub">active</div></div>`;

  const days = []; const today = new Date();
  for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(d); }
  const dayTotals = days.map(d => { const ds = d.toDateString(); return deps.filter(t => new Date(t.created_at).toDateString() === ds).reduce((s, t) => s + Number(t.amount), 0); });
  const maxAmt = Math.max(...dayTotals, 1);
  document.getElementById('barChart').innerHTML = dayTotals.map((amt, i) => `<div class="bar-item"><div class="bar" style="height:${Math.max(4, Math.round((amt / maxAmt) * 70))}px;" title="${fmt(amt)}"></div><div class="bar-label">${days[i].toLocaleDateString('en', { weekday: 'short' })}</div></div>`).join('');

  const { data: reps } = await db.from('representatives').select('*');
  const agentPerf = await Promise.all((reps || []).map(async r => { const { data: t } = await db.from('transactions').select('amount').eq('agent_id', r.id).eq('type', 'deposit'); const total = (t || []).reduce((s, x) => s + Number(x.amount), 0); return { ...r, total }; }));
  agentPerf.sort((a, b) => b.total - a.total);
  document.getElementById('topAgentsList').innerHTML = agentPerf.slice(0, 5).length
    ? agentPerf.slice(0, 5).map((r, i) => `<div class="agent-row"><div><span style="color:var(--yellow);font-weight:800;margin-right:7px;">#${i + 1}</span><span style="font-size:13px;">${r.first_name} ${r.last_name}</span><div style="color:var(--sub);font-size:10px;margin-top:2px;">ID: ${r.rep_id}</div></div><div style="color:var(--green);font-weight:700;font-size:13px;">${fmt(r.total)}</div></div>`).join('')
    : '<div class="empty-state">No agents yet</div>';
}

// ═══════════════════════════════════════════════
// FRAUD FLAGS (admin/analytics.html)
// ═══════════════════════════════════════════════
async function renderFraudFlags() {
  const { data: flags } = await db.from('fraud_flags').select('*').eq('resolved', false).order('created_at', { ascending: false });
  const el = document.getElementById('fraudFlagsList');
  if (!el) return;
  if (!flags?.length) { el.innerHTML = '<div class="empty-state">No active fraud flags</div>'; return; }
  el.innerHTML = flags.map(f => {
    const desc = (f.description || '').replace(/emergency/gi, 'withdrawal').replace(/EXCESS_EMERGENCY/g, 'EXCESS_WITHDRAWAL');
    const type = (f.type || '').replace(/emergency/gi, 'withdrawal').replace(/EXCESS_EMERGENCY/g, 'EXCESS_WITHDRAWAL');
    return `<div class="fraud-flag-card"><div class="ff-header"><span class="ff-type">${type.replace(/_/g, ' ')} · ${(f.severity||'').toUpperCase()}</span><span class="ff-time">${fmtDate(f.created_at)}</span></div><div class="ff-desc">${desc}</div><button class="btn btn-green" style="margin-top:9px;font-size:12px;padding:7px 12px;" onclick="resolveFlag('${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Mark Resolved</button></div>`;
  }).join('');
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

async function renderAuditLog() {
  const { data: logs } = await db.from('audit_log').select('*').order('created_at', { ascending: false });
  allAuditLogs = logs || [];
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
  if (cur !== currentAdminPin) { setMsg('settMsg', '<div class="msg-err">Current PIN is incorrect</div>'); return; }
  if (np.length < 8) { setMsg('settMsg', '<div class="msg-err">New PIN must be at least 8 characters</div>'); return; }
  if (np !== cp) { setMsg('settMsg', '<div class="msg-err">New PINs do not match</div>'); return; }
  currentAdminPin = np;
  await audit('login', 'Admin PIN changed');
  setMsg('settMsg', '<div class="msg-ok">PIN updated for this session. Note: to persist across sessions, update ADMIN_PIN in js/admin.js.</div>');
  ['settCurrentPin', 'settNewPin', 'settConfirmPin'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
}

// ═══════════════════════════════════════════════
// USER MANAGEMENT — bulk cleanup
// ═══════════════════════════════════════════════
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
