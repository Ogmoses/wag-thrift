// ═══════════════════════════════════════════════
// js/customer.js
// CUSTOMER DASHBOARD · PLANS · CALENDAR · WITHDRAWALS · PROFILE/SETTINGS
// Depends on: js/supabase.js, js/utils.js, js/auth.js (load all first)
// ═══════════════════════════════════════════════

let activePlanId = null, activePlanBalance = 0, balHidden = false;

function _balKey() { const u = getUser(); return u ? `wagBalHidden_${u.id}` : 'wagBalHidden'; }
function loadBalPref() { balHidden = localStorage.getItem(_balKey()) === 'true'; }
function saveBalPref() { localStorage.setItem(_balKey(), balHidden ? 'true' : 'false'); }
let _payPinCallback = null;

// ═══════════════════════════════════════════════
// SCHEDULE HELPER
// ═══════════════════════════════════════════════
function getScheduleInfo(plan, balance, totalDaysCoveredOverride) {
  const regularAmt = Number(plan.regular_contribution) || 1000;
  const start = new Date(plan.created_at);
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const calendarDaysElapsed = Math.max(0, Math.floor((today - start) / (1000 * 60 * 60 * 24)));
  const daysCovered = totalDaysCoveredOverride !== undefined
    ? totalDaysCoveredOverride
    : Math.floor(Number(balance) / regularAmt);
  const missed = Math.max(0, calendarDaysElapsed - daysCovered);
  return { expected: calendarDaysElapsed, label: 'daily', expectedTotal: calendarDaysElapsed * regularAmt, missed };
}

// ═══════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════
async function renderCustDash() {
  if (!db) return;
  const user = getUser();
  // Render header immediately from session (no DB wait)
  document.getElementById('custAv').textContent = user.first_name[0].toUpperCase();
  document.getElementById('custName').textContent = user.first_name + ' ' + user.last_name;
  document.getElementById('custPhone').textContent = user.phone;
  // Fire plans query
  const { data: plans } = await db.from('plan_balances').select('*').eq('customer_id', user.id).neq('status', 'deleted');
  if (!activePlanId || !plans?.find(p => p.plan_id === activePlanId)) activePlanId = plans?.[0]?.plan_id || null;
  const bar = document.getElementById('planTabsBar');
  bar.innerHTML = (plans || []).map(p => {
    const isOverdue = p.balance < p.target_amount && p.status === 'active';
    return `<div class="plan-tab${p.plan_id === activePlanId ? ' active' : ''}${isOverdue ? ' overdue-tab' : ''}" onclick="switchPlan('${p.plan_id}')">
      <span class="plan-tab-name">${p.name}</span>
      <span class="plan-tab-bal">${fmt(p.balance)}</span>
    </div>`;
  }).join('') + `<div class="plan-tab add-tab" onclick="openNewPlanModal()"><span class="plan-tab-add-ic">+</span><span class="plan-tab-add-lbl">New Plan</span></div>`;
  if (!activePlanId) { document.getElementById('noPlanMsg').style.display = 'block'; document.getElementById('planArea').style.display = 'none'; }
  else { document.getElementById('noPlanMsg').style.display = 'none'; document.getElementById('planArea').style.display = 'block'; await renderPlanDetail(activePlanId); }
}

async function switchPlan(id) {
  const area = document.getElementById('planArea');
  if (area) area.classList.add('plan-fade-out');
  activePlanId = id;
  await renderCustDash();
  if (area) {
    area.classList.remove('plan-fade-out');
    area.classList.add('plan-fade-in');
    setTimeout(() => area.classList.remove('plan-fade-in'), 380);
  }
}

async function renderPlanDetail(planId) {
  loadBalPref(); // restore hidden/shown preference before rendering balance
  const [{ data: plan }, { data: planExtra }, { data: allDeposits }, { data: txs }, { data: rejDisbs }] = await Promise.all([
    db.from('plan_balances').select('*').eq('plan_id', planId).single(),
    db.from('plans').select('regular_contribution,maturity_date').eq('id', planId).single(),
    db.from('transactions').select('amount').eq('plan_id', planId).in('type', ['opening', 'deposit']),
    db.from('transactions').select('*').eq('plan_id', planId).order('created_at', { ascending: false }),
    db.from('disbursements').select('*').eq('plan_id', planId).eq('status', 'rejected')
  ]);
  if (!plan) return;
  plan.regular_contribution = planExtra?.regular_contribution || 0;
  const nameEl = document.getElementById('planNameDisplay');
  if (nameEl) nameEl.textContent = plan.name || '—';
  activePlanBalance = Number(plan.balance || 0);
  const regularAmt = Number(plan.regular_contribution) || 1000;
  const totalDeposited = (allDeposits || []).reduce((s, t) => s + Number(t.amount), 0);
  const totalDaysCovered = Math.floor(totalDeposited / regularAmt);
  document.getElementById('planBal').textContent = balHidden ? '••••••' : fmt(activePlanBalance);
  const eyeBtn = document.querySelector('.eye-btn');
  if (eyeBtn) eyeBtn.innerHTML = balHidden ? EYE_CLOSED : EYE_OPEN;
  document.getElementById('planPct').textContent = '';
  const sched = getScheduleInfo(plan, activePlanBalance, totalDaysCovered);
  const isOverdue = sched.missed > 0;
  const badge = document.getElementById('planBadge');
  badge.textContent = plan.status === 'closed' ? 'CLOSED' : isOverdue ? 'OVERDUE' : 'ACTIVE';
  badge.className = 'bal-badge ' + (plan.status === 'closed' ? 'badge-done' : isOverdue ? 'badge-overdue' : 'badge-active');
  document.getElementById('planType').textContent = (plan.frequency || 'Daily') + ' · ' + fmt(plan.regular_contribution || 0);
  const isClosed = plan.status === 'closed';
  document.getElementById('planActionBtns').style.display = isClosed ? 'none' : 'grid';
  document.getElementById('planClosedNotice').style.display = isClosed ? 'block' : 'none';
  if (isClosed && document.getElementById('closedPlanBal')) document.getElementById('closedPlanBal').textContent = fmt(activePlanBalance);
  document.getElementById('planStart').textContent = fmtDate(plan.created_at);
  if (db) renderCalendar(plan, activePlanBalance);
  const ob = document.getElementById('overdueBanner');
  if (isOverdue) { ob.style.display = 'flex'; document.getElementById('overdueCount').textContent = `${sched.missed} ${sched.label} contribution${sched.missed !== 1 ? 's' : ''} overdue`; }
  else ob.style.display = 'none';
  const schedLabel = sched.label || 'period';
  document.getElementById('scheduleBlock').innerHTML = `
   <div class="sched-row"><span class="sched-label">Regular contribution</span><span class="sched-val">${regularAmt > 0 ? fmt(regularAmt) + ' / ' + schedLabel : 'Not set'}</span></div>
   <div class="sched-row" style="border-bottom:none;"><span class="sched-label">Missed contributions</span><span class="sched-val ${sched.missed === 0 ? 'ok' : sched.missed < 3 ? 'warn' : 'bad'}">${sched.missed === 0 ? 'None' : sched.missed}</span></div>`;
  let rejRows = [];
  try {
    rejRows = (rejDisbs || []).map(d => ({ id: d.id, type: 'rejected', amount: d.amount, created_at: d.requested_at, ref: d.ref }));
  } catch (e) { console.warn('tx processing error:', e); }
  const allTxs = [...(txs || []), ...rejRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const txList = document.getElementById('txList');
  if (!allTxs || !allTxs.length) { txList.innerHTML = '<div class="tx-empty">No transactions yet</div>'; }
  else {
    txList.innerHTML = allTxs.slice(0, 3).map(tx => {
      const isIn = tx.type === 'deposit' || tx.type === 'opening';
      const label = tx.type === 'opening' ? 'Opening Contribution' : tx.type === 'deposit' ? 'Deposit' : tx.type === 'rejected' ? 'Rejected Withdrawal' : 'Payout';
      return `<div class="tx-row"><div class="tx-ico ${isIn ? 'tx-ico-g' : 'tx-ico-r'}">${isIn ? '↓' : '↑'}</div><div class="tx-body"><div class="tx-name">${label}</div><div class="tx-dt">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)}</div><div class="tx-ref">${tx.ref || '—'}</div></div><div class="${isIn ? 'tx-amt-g' : 'tx-amt-r'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</div></div>`;
    }).join('');
  }
}

function toggleBalVis() {
  balHidden = !balHidden;
  saveBalPref();
  document.getElementById('planBal').textContent = balHidden ? '••••••' : fmt(activePlanBalance);
  const btn = document.querySelector('.eye-btn');
  if (btn) btn.innerHTML = balHidden ? EYE_CLOSED : EYE_OPEN;
}

// ═══════════════════════════════════════════════
// PLANS — create / close / reactivate / delete
// ═══════════════════════════════════════════════
async function openNewPlanModal() { showModal('newPlanModal'); }

async function doCreatePlan() { guardedSubmit('createPlan', () => _doCreatePlan()); }
async function _doCreatePlan() {
  if (!dbReady()) return;
  const name = (document.getElementById('npName')?.value || '').trim();
  const contribVal = (document.getElementById('npContrib')?.value || '').trim();
  if (!name) { setMsg('npMsg', '<div class="msg-err">Please enter a plan name</div>'); return; }
  if (!contribVal || isNaN(+contribVal) || +contribVal <= 0) { setMsg('npMsg', '<div class="msg-err">Please enter your daily contribution amount</div>'); return; }
  const user = getUser();
  showLoading('Creating plan…');
  const { data: plan, error } = await db.from('plans').insert({
    customer_id: user.id, name, frequency: 'Daily',
    regular_contribution: +contribVal,
    target_amount: 99999999, maturity_date: '2099-12-31'
  }).select().single();
  if (error) { hideLoading(); setMsg('npMsg', `<div class="msg-err">${error.message}</div>`); return; }
  await audit('plan', user.id, 'customer', `${user.first_name} ${user.last_name} created a new savings plan: "${name}" — Daily ₦${+contribVal}`, null, plan.id);
  hideLoading(); activePlanId = plan.id;
  setMsg('npMsg', '<div class="msg-ok">Plan created!</div>');
  setTimeout(async () => {
    closeModal('newPlanModal'); setMsg('npMsg', '');
    ['npName', 'npContrib'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    await renderCustDash();
    const { data: fresh } = await db.from('customers').select('payment_pin_hash').eq('id', user.id).single();
    if (!fresh?.payment_pin_hash) { openPayPinSetupModal(); }
  }, 1200);
}

// ═══════════════════════════════════════════════
// SMOOTH ALERT / CONFIRM (replaces native alert()/confirm())
// Same pattern as representative.js — see comment there.
// ═══════════════════════════════════════════════
const CUST_ALERT_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:44px;height:44px;"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:44px;height:44px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="#011f7b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:44px;height:44px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};
function showCustAlert(title, msg, variant = 'info') {
  const iconEl = document.getElementById('custAlertIcon');
  if (iconEl) iconEl.innerHTML = CUST_ALERT_ICONS[variant] || CUST_ALERT_ICONS.info;
  const titleEl = document.getElementById('custAlertTitle'); if (titleEl) titleEl.textContent = title;
  const msgEl = document.getElementById('custAlertMsg'); if (msgEl) msgEl.textContent = msg;
  showModal('custAlertModal');
}

let custConfirmOkHandler = () => {};
function showCustConfirm(title, msg, onOk) {
  const titleEl = document.getElementById('custConfirmTitle'); if (titleEl) titleEl.textContent = title;
  const msgEl = document.getElementById('custConfirmMsg'); if (msgEl) msgEl.textContent = msg;
  custConfirmOkHandler = () => { closeModal('custConfirmModal'); onOk(); };
  showModal('custConfirmModal');
}

async function closePlan() {
  if (!activePlanId) return;
  const { data: pb } = await db.from('plan_balances').select('balance,name').eq('plan_id', activePlanId).single();
  const bal = Number(pb?.balance || 0);
  if (bal > 0) { showCustAlert('Cannot Close Plan', `"${pb.name}" still has a balance of ${fmt(bal)}.\n\nPlease withdraw all your money first. Once your balance is ₦0.00, you can close this plan.`, 'error'); return; }
  showCustConfirm('Close Plan', `Close "${pb.name}"? This will make it inactive. You can reactivate later.`, async () => {
    showLoading('Closing plan…');
    const u = getUser();
    await db.from('plans').update({ status: 'closed' }).eq('id', activePlanId);
    await audit('plan', u.id, 'customer',
      `${u.first_name} ${u.last_name} closed plan "${pb.name || ''}"`,
      null, activePlanId);
    hideLoading(); await renderCustDash();
  });
}

async function reactivatePlan() {
  if (!activePlanId) return;
  const { data: pb } = await db.from('plan_balances').select('name').eq('plan_id', activePlanId).single();
  showLoading('Reactivating…');
  const u = getUser();
  await db.from('plans').update({ status: 'active' }).eq('id', activePlanId);
  await audit('plan', u.id, 'customer',
    `${u.first_name} ${u.last_name} reactivated plan "${pb?.name || ''}"`,
    null, activePlanId);
  hideLoading(); await renderCustDash();
}

async function permanentlyDeletePlan() {
  if (!activePlanId) return;
  const { data: pb } = await db.from('plan_balances').select('balance,name').eq('plan_id', activePlanId).single();
  showCustConfirm('Delete Plan Permanently', `Permanently delete "${pb?.name || ''}"? This cannot be undone.`, async () => {
    showLoading('Deleting…');
    const u = getUser();
    await db.from('plans').update({ status: 'deleted' }).eq('id', activePlanId);
    await audit('plan', u.id, 'customer',
      `${u.first_name} ${u.last_name} permanently deleted plan "${pb?.name || ''}"`,
      null, activePlanId);
    hideLoading(); activePlanId = null; await renderCustDash();
  });
}

// ═══════════════════════════════════════════════
// RENAME PLAN
// ═══════════════════════════════════════════════
function openRenamePlanModal() {
  if (!activePlanId) return;
  const current = document.getElementById('planNameDisplay')?.textContent || '';
  document.getElementById('renamePlanInp').value = current === '—' ? '' : current;
  setMsg('renamePlanMsg', '');
  showModal('renamePlanModal');
}

async function doRenamePlan() { await guardedAction('renamePlan', _doRenamePlan); }
async function _doRenamePlan() {
  if (!activePlanId) return;
  const newName = document.getElementById('renamePlanInp').value.trim();
  if (!newName) { setMsg('renamePlanMsg', '<div class="msg-err">Please enter a plan name</div>'); return; }
  if (newName.length > 40) { setMsg('renamePlanMsg', '<div class="msg-err">Name is too long (max 40 characters)</div>'); return; }
  showLoading('Renaming…');
  const { data: pb } = await db.from('plan_balances').select('name').eq('plan_id', activePlanId).single();
  const oldName = pb?.name || '';
  const { error } = await db.from('plans').update({ name: newName }).eq('id', activePlanId);
  if (error) { hideLoading(); setMsg('renamePlanMsg', `<div class="msg-err">${error.message}</div>`); return; }
  const user = getUser();
  await audit('plan', user.id, 'customer', `${user.first_name} ${user.last_name} renamed plan "${oldName}" to "${newName}"`, null, activePlanId);
  hideLoading();
  closeModal('renamePlanModal');
  await renderCustDash();
}

// ═══════════════════════════════════════════════
// WITHDRAWAL REQUEST (payment PIN protected)
// ═══════════════════════════════════════════════
function openWithdrawalModal() { requirePayPin('Payment PIN', 'Enter your payment PIN to withdraw money.', () => _openWithdrawalModal()); }
async function _openWithdrawalModal() {
  const user = getUser();
  const { data: plans } = await db.from('plan_balances').select('*').eq('customer_id', user.id).eq('status', 'active').neq('status', 'deleted');
  if (!plans?.length) { showCustAlert('No Active Plans', 'You have no active plans to withdraw from', 'error'); return; }
  const sel = document.getElementById('wdPlan');
  sel.innerHTML = '<option value="">— Select plan —</option>';
  plans.forEach(p => sel.innerHTML += `<option value="${p.plan_id}">${p.name} (${fmt(p.balance)})</option>`);
  if (activePlanId) sel.value = activePlanId;
  showModal('withdrawalModal');
}

async function doWithdrawalRequest() { guardedSubmit('withdrawalRequest', () => _doWithdrawalRequest()); }
async function _doWithdrawalRequest() {
  const planId = document.getElementById('wdPlan').value, amtVal = document.getElementById('wdAmt').value.trim(), reason = document.getElementById('wdReason').value.trim();
  if (!planId) { setMsg('wdMsg', '<div class="msg-err">Please select a plan</div>'); return; }
  if (!amtVal || +amtVal <= 0) { setMsg('wdMsg', '<div class="msg-err">Enter a valid amount</div>'); return; }
  const { data: planBal } = await db.from('plan_balances').select('balance').eq('plan_id', planId).single();
  if (+amtVal > (planBal?.balance || 0)) { setMsg('wdMsg', `<div class="msg-err">Amount exceeds plan balance of ${fmt(planBal?.balance)}</div>`); return; }
  const user = getUser();
  const ref = 'WAG-WD-' + Date.now();
  showLoading('Submitting request…');
  try {
    const { data, error } = await db.rpc('request_withdrawal', {
      p_plan_id: planId,
      p_amount: +amtVal,
      p_reason: reason,
      p_ref: ref
    });
    if (error) throw new Error(error.message);
    await checkExcessWithdrawal(user.id);
    setMsg('wdMsg', '<div class="msg-ok">✓ Request submitted! A representative will approve it shortly.</div>');
    setTimeout(() => { closeModal('withdrawalModal'); setMsg('wdMsg', ''); document.getElementById('wdAmt').value = ''; document.getElementById('wdReason').value = ''; }, 2500);
  } catch (e) {
    console.error('Withdrawal request failed:', e);
    setMsg('wdMsg', `<div class="msg-err">Could not submit request: ${e.message || 'Unknown error. Please try again.'}</div>`);
  } finally {
    hideLoading();
  }
}

function milAct(act) { closeModal('milestoneModal'); if (act === 'payout') openWithdrawalModal(); else if (act === 'extend') showCustAlert('Extend Plan', 'Contact your representative to extend the plan date.', 'info'); else if (act === 'increase') openNewPlanModal(); }

// ═══════════════════════════════════════════════
// PAYMENT PIN — generic verify-before-action (customer & representative)
// ═══════════════════════════════════════════════
function requirePayPin(title, desc, callback) {
  _payPinCallback = callback;
  document.getElementById('payPinTitle').textContent = title || 'Enter Payment PIN';
  document.getElementById('payPinDesc').textContent = desc || 'Enter your 4–6 digit payment PIN to continue.';
  document.getElementById('payPinInp').value = '';
  setMsg('payPinMsg', '');
  showModal('payPinModal');
}
async function confirmPayPin() {
  const pin = document.getElementById('payPinInp').value.trim();
  if (!pin || pin.length < 4) { setMsg('payPinMsg', '<div class="msg-err">Enter your 4–6 digit payment PIN</div>'); return; }
  const pinHash = await hashPin(pin);
  // verify_payment_pin now identifies the caller via auth.uid() (real
  // Supabase Auth session) — no need to pass or pre-check the customer ID.
  const { data: valid, error } = await db.rpc('verify_payment_pin', { p_pin_hash: pinHash });
  if (error || valid !== true) {
    setMsg('payPinMsg', '<div class="msg-err">Incorrect PIN. Try again.</div>');
    return;
  }
  closeModal('payPinModal');
  document.getElementById('payPinInp').value = '';
  if (_payPinCallback) { _payPinCallback(); _payPinCallback = null; }
}

function openPayPinSetupModal() {
  document.getElementById('setupPinInp').value = '';
  document.getElementById('setupPinMsg').innerHTML = '';
  showModal('payPinSetupModal');
}
async function saveSetupPayPin() {
  const u = getUser();
  const pin = document.getElementById('setupPinInp').value.trim();
  if (!/^\d{4,6}$/.test(pin)) { setMsg('setupPinMsg', '<div class="msg-err">PIN must be 4–6 digits</div>'); return; }
  showLoading('Saving PIN…');
  const hash = await hashPin(pin);
  await db.from('customers').update({ payment_pin_hash: hash }).eq('id', u.id);
  setUser({ ...u, payment_pin_hash: hash });
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} set their payment PIN`);
  hideLoading();
  closeModal('payPinSetupModal');
}

// ═══════════════════════════════════════════════
// MINI CALENDAR — ongoing daily thrift streak
// ═══════════════════════════════════════════════
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let calState = { yr: 0, mo: 0, covered: new Set(), partial: new Map(), missed: new Set(), payouts: new Set(), actualPayDays: new Set() };

// ─── SPILLOVER SLOT ALLOCATION ─────────────────────────────────────────
// Deposits no longer have to be exact multiples of the daily Rate (see
// doCollection() in representative.js) — a customer can pay ₦500 on a
// ₦1,000 rate, or ₦1,700, or anything positive. This walks the plan's
// cumulative total forward across calendar days from planStart, filling
// each day's slot completely before moving to the next:
//   Slots = totalDeposited / regularAmt
//   whole days  -> fully covered ("green")
//   leftover    -> the ONE day right after them is "partial" at that
//                  fraction (½, ¼, ¾, ...)
//   everything after that, up to (not including) today -> "missed"
//
// Because this is always recomputed from the TOTAL cumulative deposit
// (not per-transaction), "partial payments fill open fractional slots
// from prior days before advancing" falls out automatically — a day
// that's ½-filled today and receives another ₦500 tomorrow recomputes
// as fully covered, with the leftover (if any) rolling to the day after.
// No separate state to track for that: same mechanism the pre-existing
// `covered` set already used for whole-day catch-up payments, just
// extended to expose the leftover fraction instead of discarding it.
function computeSlotAllocation(planStart, today, totalDeposited, regularAmt) {
  const EPS = 1e-9;
  const totalSlots = regularAmt > 0 ? totalDeposited / regularAmt : 0;
  const wholeSlots = Math.floor(totalSlots + EPS);
  const remainder = totalSlots - wholeSlots; // in [0, 1)

  const covered = new Set();
  const partial = new Map(); // dateKey -> fraction (0 < f < 1)
  const missed = new Set();

  const walker = new Date(planStart);
  for (let i = 0; i < wholeSlots; i++) {
    covered.add(dateKey(walker));
    walker.setDate(walker.getDate() + 1);
  }

  // walker now sits on the first day not fully covered.
  if (remainder > EPS) partial.set(dateKey(walker), remainder);

  const missWalker = new Date(walker);
  // A day carrying a partial fraction is in progress, not missed.
  if (remainder > EPS) missWalker.setDate(missWalker.getDate() + 1);
  while (missWalker < today) {
    missed.add(dateKey(missWalker));
    missWalker.setDate(missWalker.getDate() + 1);
  }

  return { covered, partial, missed };
}

// Traditional fraction glyph for a partial slot. Snaps to the common
// clean fractions a half/quarter payment actually produces; anything
// that doesn't land near one of those (now possible since any positive
// amount is valid — e.g. ₦333 on a ₦1,000 rate) falls back to a percent
// rather than mislabeling it as the nearest glyph.
function fractionGlyph(frac) {
  const EPS = 0.02;
  if (Math.abs(frac - 0.25) < EPS) return '¼';
  if (Math.abs(frac - 0.5) < EPS) return '½';
  if (Math.abs(frac - 0.75) < EPS) return '¾';
  if (Math.abs(frac - 1 / 3) < EPS) return '⅓';
  if (Math.abs(frac - 2 / 3) < EPS) return '⅔';
  return Math.round(frac * 100) + '%';
}

async function renderCalendar(plan, balance) {
  const regularAmt = Number(plan.regular_contribution) || 1000;
  const planStart = new Date(plan.created_at);
  planStart.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const planId = plan.plan_id || plan.id;

  const [txRes, disbRes] = await Promise.all([
    db.from('transactions').select('amount,created_at,type').eq('plan_id', planId)
      .in('type', ['opening', 'deposit']).order('created_at', { ascending: true }),
    db.from('disbursements').select('confirmed_at,amount').eq('plan_id', planId)
      .eq('status', 'paid')
  ]);
  const txs = txRes.data || [];
  const paidDisbs = disbRes.data || [];

  const totalDeposited = txs.reduce((s, t) => s + Number(t.amount), 0);

  calState.payouts = new Set();
  // Distinct real calendar days a deposit actually landed on — independent
  // of `covered`/`partial` below, which are a cumulative "how many
  // day-units has your money paid for" abstraction (lets a catch-up lump
  // sum retroactively paint past missed days green), correct for the
  // calendar's job but wrong as a streak basis: a single catch-up deposit
  // shouldn't be able to hand back a broken streak. actualPayDays only
  // ever reflects days a transaction genuinely happened — of any size,
  // a ₦50 top-up counts exactly the same as a full day's Rate — so a
  // streak built from it truly resets on a missed day and can't be
  // patched retroactively, and doesn't require reaching a full slot.
  calState.actualPayDays = new Set(txs.map(t => dateKey(new Date(t.created_at))));

  paidDisbs.forEach(d => {
    if (d.confirmed_at) {
      calState.payouts.add(dateKey(new Date(d.confirmed_at)));
    }
  });

  const { covered, partial, missed } = computeSlotAllocation(planStart, today, totalDeposited, regularAmt);
  calState.covered = covered;
  calState.partial = partial;
  calState.missed = missed;

  calState.yr = today.getFullYear();
  calState.mo = today.getMonth();
  drawCal();
}

function drawCal() {
  const { yr, mo, covered, partial, missed, payouts } = calState;
  const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const todayStr = dateKey(new Date());
  const rawFirstDay = new Date(yr, mo, 1).getDay(); // 0=Sun..6=Sat
  const firstDay = (rawFirstDay + 6) % 7; // shifted to 0=Mon..6=Sun
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const lbl = document.getElementById('calMonthLbl');
  const hdr = document.getElementById('calDaysHdr');
  const grid = document.getElementById('calGrid');
  if (!lbl || !hdr || !grid) return;
  lbl.textContent = MN[mo] + ' ' + yr;

  // Build day cells as <td> strings, chunked into rows of 7
  const tds = [];
  for (let i = 0; i < firstDay; i++) tds.push('<td></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isPayout = payouts.has(ds);
    const isCovered = covered.has(ds);
    const partialFrac = partial.get(ds); // undefined if not a partial day
    const isMissed = missed.has(ds);
    const isToday = ds === todayStr;
    let cls = 'cal-cell';
    let title = '';
    let badge = '';
    if (isPayout) { cls += ' c-payout'; title = 'Withdrawal day'; }
    else if (isCovered) { cls += ' c-green'; title = 'Paid'; badge = '✓'; }
    else if (partialFrac !== undefined) {
      cls += ' c-partial'; title = `Partially paid (${fractionGlyph(partialFrac)} slot)`;
      badge = fractionGlyph(partialFrac);
    }
    else if (isMissed) { cls += ' c-red'; title = 'Missed'; }
    else { cls += ' c-grey'; }
    if (isToday) cls += ' c-today';
    const fillStyle = partialFrac !== undefined ? ` style="--fill:${(partialFrac * 100).toFixed(1)}%"` : '';
    const badgeHtml = badge ? `<span class="cal-badge">${badge}</span>` : '';
    tds.push(`<td class="${cls}" title="${title}"${fillStyle}><span class="cal-daynum">${d}</span>${badgeHtml}</td>`);
  }
  while (tds.length % 7 !== 0) tds.push('<td></td>');

  let rows = '';
  for (let i = 0; i < tds.length; i += 7) rows += '<tr>' + tds.slice(i, i + 7).join('') + '</tr>';

  // Days-of-week header row, built as a <table> too so columns align
  // exactly with the day-grid table below (both use table-layout:fixed
  // with equal-width columns).
  hdr.innerHTML = `<table class="mini-cal-table"><tr>${DN.map(d => `<td class="cal-day-hdr">${d}</td>`).join('')}</tr></table>`;
  grid.innerHTML = `<table class="mini-cal-table">${rows}</table>`;
}

function prevCalMonth() { calState.mo--; if (calState.mo < 0) { calState.mo = 11; calState.yr--; } drawCal(); }
function nextCalMonth() { calState.mo++; if (calState.mo > 11) { calState.mo = 0; calState.yr++; } drawCal(); }

function initCalSwipe() {
  const wrap = document.getElementById('calGrid');
  if (!wrap || !wrap.parentElement) return;
  // Guard against duplicate binding: loadCalendarPage() (and therefore this
  // function) reruns every time the plan switcher is used on the standalone
  // Streaks tab. Without this guard, each switch stacked another pair of
  // touch listeners on the same element with nothing ever removing the old
  // ones — so after switching plans twice, a single swipe fired
  // next/prevCalMonth() three times, only ever landing on every 3rd month.
  if (wrap.parentElement.dataset.swipeBound === '1') return;
  wrap.parentElement.dataset.swipeBound = '1';
  let sx = 0;
  wrap.parentElement.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  wrap.parentElement.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) { dx < 0 ? nextCalMonth() : prevCalMonth(); }
  }, { passive: true });
}

// ═══════════════════════════════════════════════
// TRANSACTIONS PAGE (customer/transactions.html)
// Shows transactions across ALL of the customer's plans, with a
// category filter (deposit / opening / payout / rejected).
// ═══════════════════════════════════════════════
let _custTxAll = [];

async function loadCustTxPage() {
  const el = document.getElementById('custTxSubList');
  el.innerHTML = '<div class="tx-empty">Loading…</div>';
  const user = getUser();
  const { data: plans } = await db.from('plan_balances').select('plan_id,name').eq('customer_id', user.id).neq('status', 'deleted');
  const planIds = (plans || []).map(p => p.plan_id);
  const planNameMap = {}; (plans || []).forEach(p => planNameMap[p.plan_id] = p.name);
  const planSel = document.getElementById('custTxPlanFilter');
  if (planSel) {
    planSel.innerHTML = '<option value="all">All Plans</option>' + (plans || []).map(p => `<option value="${p.plan_id}">${p.name}</option>`).join('');
  }
  if (!planIds.length) { el.innerHTML = '<div class="tx-empty">No plans yet</div>'; return; }
  const [{ data: txs }, { data: rDbs }] = await Promise.all([
    db.from('transactions').select('*').in('plan_id', planIds).order('created_at', { ascending: false }),
    db.from('disbursements').select('*').in('plan_id', planIds).eq('status', 'rejected')
  ]);
  _custTxAll = [...(txs || []), ...(rDbs || []).map(d => ({ ...d, type: 'rejected', created_at: d.requested_at }))]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  _custTxAll.forEach(t => t._planName = planNameMap[t.plan_id] || '');
  renderCustTxList();
}

function renderCustTxList() {
  const el = document.getElementById('custTxSubList');
  const cat = document.getElementById('custTxCatFilter')?.value || 'all';
  const planFilter = document.getElementById('custTxPlanFilter')?.value || 'all';
  let filtered = cat === 'all' ? _custTxAll : _custTxAll.filter(t => t.type === cat);
  if (planFilter !== 'all') filtered = filtered.filter(t => t.plan_id === planFilter);
  if (!filtered.length) { el.innerHTML = '<div class="tx-empty">No transactions yet</div>'; return; }
  el.innerHTML = filtered.map(tx => {
    const isIn = tx.type === 'deposit' || tx.type === 'opening';
    const isReserved = tx.ref?.startsWith('RESERVE-');
    const lbl = tx.type === 'opening' ? 'Opening'
      : tx.type === 'deposit' ? 'Deposit'
      : tx.type === 'payout' ? (isReserved ? 'Withdrawal' : 'Payout')
      : 'Rejected';
    const refDisplay = isReserved ? 'Withdrawal request' : (tx.ref || '—');
    const badge = `<span style="background:${isIn ? '#d1fae5' : '#fee2e2'};color:${isIn ? '#065f46' : '#991b1b'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;">${isReserved ? 'withdrawal' : tx.type}</span>`;
    return `<div class="tx-row">
     <div class="tx-ico ${isIn ? 'tx-ico-g' : 'tx-ico-r'}">${isIn ? '↓' : '↑'}</div>
     <div class="tx-body"><div class="tx-name">${lbl}${tx._planName ? ' · ' + tx._planName : ''}</div><div class="tx-dt">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)}</div><div class="tx-ref">${refDisplay}</div><div style="margin-top:3px;">${badge}</div></div>
     <div class="${isIn ? 'tx-amt-g' : 'tx-amt-r'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════
// SETTINGS / PROFILE PAGE (customer/settings.html)
// ═══════════════════════════════════════════════
function buildCustProfilePage() {
  const u = getUser(); if (!u) return;
  const el = document.getElementById('custProfileContent'); if (!el) return;
  const emailCell = isPlaceholderEmail(u.email)
    ? `<button type="button" onclick="openAddEmailModal()" style="background:none;border:none;color:var(--blue);font-weight:700;font-size:13px;cursor:pointer;padding:0;">+ Add Email</button>`
    : `<span onclick="openAddEmailModal()" style="cursor:pointer;">${u.email}</span>`;
  const addressCell = isPlaceholderAddress(u.address)
    ? `<button type="button" onclick="openAddAddressModal()" style="background:none;border:none;color:var(--blue);font-weight:700;font-size:13px;cursor:pointer;padding:0;">+ Add Address</button>`
    : `<span onclick="openAddAddressModal()" style="cursor:pointer;">${u.address}</span>`;
  el.innerHTML = `
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> My Profile</div>
    <div class="profile-row"><span class="profile-lbl">Full Name</span><span class="profile-val">${u.first_name || ''} ${u.last_name || ''}</span></div>
    <div class="profile-row"><span class="profile-lbl">Phone</span><span class="profile-val">${(u.phone || '').replace('+234', '0')}</span></div>
    <div class="profile-row"><span class="profile-lbl">Email</span><span class="profile-val">${emailCell}</span></div>
    <div class="profile-row"><span class="profile-lbl">Address</span><span class="profile-val">${addressCell}</span></div>
    <div class="profile-row"><span class="profile-lbl">Member Since</span><span class="profile-val">${fmtDate(u.created_at)}</span></div>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M21 12h-2M5 12H3M12 21v-2M12 5V3"/></svg> Appearance</div>
    <div style="font-size:12px;color:var(--sub);margin-bottom:10px;">Choose how WAG looks on this device</div>
    <div class="theme-selector">
     <button class="theme-opt${_themePref === 'light' ? ' active' : ''}" data-theme="light" onclick="setThemePref('light')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block;margin:0 auto 4px;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>Light</button>
     <button class="theme-opt${_themePref === 'dark' ? ' active' : ''}" data-theme="dark" onclick="setThemePref('dark')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block;margin:0 auto 4px;"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>Dark</button>
     <button class="theme-opt${_themePref === 'system' ? ' active' : ''}" data-theme="system" onclick="setThemePref('system')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:block;margin:0 auto 4px;"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>System</button>
    </div>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Change Password</div>
    <div class="mform-group"><label class="form-lbl">Current Password</label>
     <div class="pin-wrap"><input type="password" id="cpCurPw" class="form-inp" placeholder="Current password" maxlength="100"><button type="button" class="pw-eye" onclick="togglePw('cpCurPw')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="mform-group"><label class="form-lbl">New Password</label>
     <div class="pin-wrap"><input type="password" id="cpNewPw" class="form-inp" placeholder="New password (min 6)" maxlength="100"><button type="button" class="pw-eye" onclick="togglePw('cpNewPw')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div id="cpPwMsg"></div>
    <button class="btn btn-blue" style="margin-bottom:0;" onclick="changeCustPassword()">Update Password</button>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg> Update Withdrawal PIN</div>
    <div class="mform-group"><label class="form-lbl">Current Withdrawal PIN</label>
     <div class="pin-wrap"><input type="password" id="cpCurPin" class="form-inp" placeholder="Current PIN" maxlength="6" inputmode="numeric"><button type="button" class="pw-eye" onclick="togglePw('cpCurPin')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="mform-group"><label class="form-lbl">New Withdrawal PIN</label>
     <div class="pin-wrap"><input type="password" id="cpNewPin" class="form-inp" placeholder="4–6 digits" maxlength="6" inputmode="numeric"><button type="button" class="pw-eye" onclick="togglePw('cpNewPin')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div id="cpPinMsg"></div>
    <button class="btn btn-blue" style="margin-bottom:0;" onclick="changeCustPayPin()">Update Withdrawal PIN</button>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Account</div>
    <button class="btn" style="background:#fee2e2;color:var(--red);margin-bottom:0;" onclick="doLogout()">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
     Sign Out
    </button>
   </div>`;
}

async function changeCustPassword() {
  const u = getUser();
  const cur = document.getElementById('cpCurPw').value;
  const nw = document.getElementById('cpNewPw').value;
  if (!cur || !nw) { setMsg('cpPwMsg', '<div class="msg-err">Fill in both fields</div>'); return; }
  if (nw.length < 6) { setMsg('cpPwMsg', '<div class="msg-err">New password must be at least 6 characters</div>'); return; }
  showLoading('Verifying…');
  // Verify the current password by re-checking it against the live Supabase
  // Auth session's email (re-authenticating confirms the password is correct
  // without us ever storing/comparing it ourselves).
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user?.email) { hideLoading(); setMsg('cpPwMsg', '<div class="msg-err">Session expired. Please sign in again.</div>'); return; }
  const { error: verifyErr } = await db.auth.signInWithPassword({ email: session.user.email, password: cur });
  if (verifyErr) { hideLoading(); setMsg('cpPwMsg', '<div class="msg-err">Current password is incorrect</div>'); return; }
  const { error: updateErr } = await db.auth.updateUser({ password: nw });
  if (updateErr) { hideLoading(); setMsg('cpPwMsg', `<div class="msg-err">${updateErr.message}</div>`); return; }
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} changed their password`);
  hideLoading();
  setMsg('cpPwMsg', '<div class="msg-ok">Password updated successfully</div>');
  document.getElementById('cpCurPw').value = '';
  document.getElementById('cpNewPw').value = '';
}

async function changeCustPayPin() {
  const u = getUser();
  const cur = document.getElementById('cpCurPin').value;
  const nw = document.getElementById('cpNewPin').value;
  if (!cur || !nw) { setMsg('cpPinMsg', '<div class="msg-err">Fill in both fields</div>'); return; }
  if (!/^\d{4,6}$/.test(nw)) { setMsg('cpPinMsg', '<div class="msg-err">PIN must be 4–6 digits</div>'); return; }
  showLoading('Verifying…');
  const curHash = await hashPin(cur);
  const { data: valid } = await db.rpc('verify_payment_pin', { p_pin_hash: curHash });
  if (valid !== true) { hideLoading(); setMsg('cpPinMsg', '<div class="msg-err">Current PIN is incorrect</div>'); return; }
  await db.from('customers').update({ payment_pin_hash: await hashPin(nw) }).eq('id', u.id);
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} changed their withdrawal PIN`);
  hideLoading(); setMsg('cpPinMsg', '<div class="msg-ok">Withdrawal PIN updated</div>');
  document.getElementById('cpCurPin').value = ''; document.getElementById('cpNewPin').value = '';
}

// ═══════════════════════════════════════════════
// ADD / EDIT EMAIL & ADDRESS (customer profile)
// Agent-created customers start with a synthetic placeholder email and a
// fixed "no address on file" placeholder — see doAgentCreateCustomer() in
// js/representative.js. buildCustProfilePage() shows a plain "+ Add Email"
// / "+ Add Address" prompt for anyone still on those placeholders (via
// isPlaceholderEmail()/isPlaceholderAddress() in js/utils.js), and the
// real value — still tappable to update — for anyone who's set one. Either
// way this only ever touches customers.email/address, never the hidden
// internal Auth email used for login.
// ═══════════════════════════════════════════════
function openAddEmailModal() {
  const u = getUser();
  document.getElementById('addEmailInp').value = isPlaceholderEmail(u.email) ? '' : u.email;
  setMsg('addEmailMsg', '');
  showModal('addEmailModal');
}
async function saveAddEmail() {
  const u = getUser();
  const val = document.getElementById('addEmailInp').value.trim();
  if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { setMsg('addEmailMsg', '<div class="msg-err">Enter a valid email address</div>'); return; }
  showLoading('Saving…');
  const { error } = await db.from('customers').update({ email: val }).eq('id', u.id);
  hideLoading();
  if (error) { setMsg('addEmailMsg', `<div class="msg-err">${error.message}</div>`); return; }
  setUser({ ...u, email: val });
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} added/updated their email address`);
  closeModal('addEmailModal');
  buildCustProfilePage();
}
function openAddAddressModal() {
  const u = getUser();
  document.getElementById('addAddressInp').value = isPlaceholderAddress(u.address) ? '' : u.address;
  setMsg('addAddressMsg', '');
  showModal('addAddressModal');
}
async function saveAddAddress() {
  const u = getUser();
  const val = document.getElementById('addAddressInp').value.trim();
  if (!val) { setMsg('addAddressMsg', '<div class="msg-err">Enter your address</div>'); return; }
  showLoading('Saving…');
  const { error } = await db.from('customers').update({ address: val }).eq('id', u.id);
  hideLoading();
  if (error) { setMsg('addAddressMsg', `<div class="msg-err">${error.message}</div>`); return; }
  setUser({ ...u, address: val });
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} added/updated their address`);
  closeModal('addAddressModal');
  buildCustProfilePage();
}

// ═══════════════════════════════════════════════
// MANDATORY PAYMENT/WITHDRAWAL PIN — enforced on every customer page
// Agent-created customers never set one during account creation (only a
// login PIN), and it used to only be prompted for lazily after creating a
// first plan. Call this after role verification on EVERY customer page —
// if the modal markup isn't on the current page (only dashboard.html has
// it), it sends them to dashboard.html where it is, and where there's no
// way to dismiss it without saving a PIN (see customer/dashboard.html —
// the old "Skip for now" button has been removed).
// ═══════════════════════════════════════════════
async function enforcePaymentPinSetup() {
  const u = getUser();
  if (!u) return;
  const { data } = await db.from('customers').select('payment_pin_hash').eq('id', u.id).single();
  if (data && !data.payment_pin_hash) {
    if (document.getElementById('payPinSetupModal')) {
      openPayPinSetupModal();
    } else {
      window.location.replace('dashboard.html');
    }
  }
}

// ═══════════════════════════════════════════════
// STANDALONE STREAKS & CALENDAR TAB (customer/calendar.html)
// Reuses the existing renderCalendar()/drawCal()/calState machinery
// from the mini-calendar above — nothing here duplicates or replaces
// that logic, it's called as-is and simply read from afterward.
// ═══════════════════════════════════════════════
async function loadCalendarPage() {
  if (!db) return;
  const user = getUser();
  const { data: plans } = await db.from('plan_balances').select('*').eq('customer_id', user.id).neq('status', 'deleted');
  if (!activePlanId || !plans?.find(p => p.plan_id === activePlanId)) activePlanId = plans?.[0]?.plan_id || null;
  const bar = document.getElementById('calPlanTabsBar');
  if (bar) {
    bar.innerHTML = (plans || []).map(p =>
      `<div class="plan-tab${p.plan_id === activePlanId ? ' active' : ''}" onclick="switchCalPlan('${p.plan_id}')">
        <span class="plan-tab-name">${p.name}</span>
        <span class="plan-tab-bal">${fmt(p.balance)}</span>
      </div>`
    ).join('');
  }
  const noPlanEl = document.getElementById('calNoPlanMsg');
  const contentEl = document.getElementById('calStandaloneContent');
  if (!activePlanId) {
    if (noPlanEl) noPlanEl.style.display = 'block';
    if (contentEl) contentEl.style.display = 'none';
    return;
  }
  if (noPlanEl) noPlanEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'block';
  const [{ data: plan }, { data: planExtra }] = await Promise.all([
    db.from('plan_balances').select('*').eq('plan_id', activePlanId).single(),
    db.from('plans').select('regular_contribution,created_at').eq('id', activePlanId).single()
  ]);
  if (!plan) return;
  plan.regular_contribution = planExtra?.regular_contribution || plan.regular_contribution;
  plan.created_at = planExtra?.created_at || plan.created_at;
  const planLbl = document.getElementById('calActivePlanName');
  if (planLbl) planLbl.textContent = plan.name || '—';
  await renderCalendar(plan, Number(plan.balance || 0));
  renderStreakStats();
  requestAnimationFrame(() => initCalSwipe());
}

function switchCalPlan(id) { activePlanId = id; loadCalendarPage(); }

function renderStreakStats() {
  const { covered, actualPayDays } = calState;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = dateKey(today);

  // Current streak — based on actualPayDays (real transaction dates), NOT
  // `covered`. This is deliberate: `covered` can be retroactively filled in
  // by a single catch-up payment, which would let a broken streak silently
  // "heal" itself. actualPayDays only contains days a deposit genuinely
  // landed, so a missed day truly breaks the count and a later lump-sum
  // catch-up cannot restore it.
  //
  // Grace period: if today has no deposit yet, the streak isn't broken
  // until the day actually ends — so we start counting from yesterday
  // instead of zeroing out the moment the clock hits midnight with no
  // deposit yet made.
  let current = 0;
  const walker = new Date(today);
  if (!actualPayDays.has(todayKey)) walker.setDate(walker.getDate() - 1);
  while (actualPayDays.has(dateKey(walker))) { current++; walker.setDate(walker.getDate() - 1); }

  // Longest streak — longest run of consecutive *real* deposit days on record
  const sortedDates = [...actualPayDays].sort();
  let longest = 0, run = 0, prevDate = null;
  sortedDates.forEach(ds => {
    if (prevDate) {
      const diffDays = Math.round((new Date(ds) - new Date(prevDate)) / 86400000);
      run = diffDays === 1 ? run + 1 : 1;
    } else run = 1;
    longest = Math.max(longest, run);
    prevDate = ds;
  });

  // Total Days Paid intentionally stays tied to the calendar's own
  // `covered` count (unchanged) — it's a running "days-worth covered"
  // total, same number the calendar itself is built from, and isn't
  // meant to claim every one of those days was an individual deposit.
  const totalPaid = covered.size;
  const goal = 30; // visual "days" goal used purely for the ring's fill %
  const pct = Math.max(0, Math.min(1, current / goal));

  const curEl = document.getElementById('streakCurrentVal');
  const longEl = document.getElementById('streakLongestVal');
  const totalEl = document.getElementById('streakTotalVal');
  const ringNumEl = document.getElementById('streakRingNum');
  const ringFg = document.getElementById('streakRingFg');
  if (curEl) curEl.textContent = current;
  if (longEl) longEl.textContent = longest;
  if (totalEl) totalEl.textContent = totalPaid;
  if (ringNumEl) ringNumEl.textContent = current;
  if (ringFg) {
    const r = 57.5, c = 2 * Math.PI * r;
    ringFg.style.strokeDasharray = c.toFixed(2);
    ringFg.style.strokeDashoffset = (c * (1 - pct)).toFixed(2);
  }
}

// ═══════════════════════════════════════════════
// OFFLINE APP-SHELL SUPPORT
// Lets the app itself open with no signal, so a customer at least sees
// their last-known dashboard instead of a blank browser error. Live data
// (balances, transactions) still needs a real connection either way —
// this only covers the app shell loading in the first place.
// ═══════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(rootPath() + 'sw.js', { scope: rootPath() || '/' }).catch(e => console.error('SW registration failed:', e));
  });
}
