// ═══════════════════════════════════════════════
// js/utils.js
// GENERIC UI / FORMAT / ICON HELPERS — used by every page
// ═══════════════════════════════════════════════

// ── DOUBLE-TAP GUARD — prevents duplicate submissions
const _actionLocks = {};
function acquireActionLock(key) { if (_actionLocks[key]) return false; _actionLocks[key] = true; return true; }
function releaseActionLock(key) { _actionLocks[key] = false; }
async function guardedAction(key, fn) {
  if (!acquireActionLock(key)) { console.warn('Action "' + key + '" already in progress — duplicate tap ignored'); return; }
  try { await fn(); } finally { releaseActionLock(key); }
}

// ── FORMATTERS
const fmt = n => '₦' + (+n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const fmtTime = d => d ? new Date(d).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : '—';
const normPhone = raw => { const n = (raw || '').replace(/\D/g, ''); if (n.length === 11 && n[0] === '0') return '+234' + n.slice(1); if (n.length === 13 && n.startsWith('234')) return '+' + n; return '+234' + n; };
const genRef = () => 'WAG-TX-' + Math.floor(10000 + Math.random() * 90000);
const genRepId = () => String(Math.floor(100000 + Math.random() * 900000));
const genToken = () => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let t = 'WAGE-'; for (let i = 0; i < 8; i++) t += c[Math.floor(Math.random() * c.length)]; return t; };

// ── PASSWORD VISIBILITY ICONS
const EYE_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
function togglePw(id) {
  const e = document.getElementById(id);
  const isHidden = e.type === 'password';
  e.type = isHidden ? 'text' : 'password';
  const btn = e.parentElement.querySelector('.pw-eye');
  if (btn) btn.innerHTML = isHidden ? EYE_CLOSED : EYE_OPEN;
}

// ── MESSAGE / MODAL / LOADING HELPERS
function setMsg(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function showModal(id) { const el = document.getElementById(id); if (el) el.classList.add('active'); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('active'); }
function showLoading(text = 'Please wait…') {
  const t = document.getElementById('loadingText'); if (t) t.textContent = text;
  const o = document.getElementById('loadingOverlay'); if (o) o.classList.add('active');
}
function hideLoading() {
  const o = document.getElementById('loadingOverlay'); if (o) o.classList.remove('active');
}

// ── ROOT PATH HELPER — makes redirects work whether the site is served
// from a domain root OR a subfolder (e.g. GitHub Pages project sites at
// https://user.github.io/repo-name/). Pages live either at the site root
// (index.html, login.html…) or one level deep (customer/, representative/,
// admin/). This returns '' or '../' accordingly.
function rootPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const dir = parts[parts.length - 2];
  return (dir === 'customer' || dir === 'representative' || dir === 'admin') ? '../' : '';
}
let _themePref = 'system'; // 'system' | 'light' | 'dark'

function applyTheme(pref) {
  _themePref = pref;
  const isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', isDark);
  const moonSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:inline-block;vertical-align:middle;"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  const sunSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:inline-block;vertical-align:middle;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  ['landThemeBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = isDark ? moonSVG : sunSVG; });
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === pref);
  });
  localStorage.setItem('wagTheme', pref);
}
function initTheme() {
  const saved = localStorage.getItem('wagTheme') || 'system';
  applyTheme(saved);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (_themePref === 'system') applyTheme('system');
  });
}
function toggleTheme() { applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark'); }
function setThemePref(p) { applyTheme(p); }
