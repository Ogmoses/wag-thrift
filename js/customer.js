// ═══════════════════════════════════════════════
// js/customer.js
// CUSTOMER DASHBOARD · PLANS · CALENDAR · WITHDRAWALS · PROFILE/SETTINGS
// Depends on: js/supabase.js, js/utils.js, js/auth.js (load all first)
// ═══════════════════════════════════════════════

let activePlanId = null, activePlanBalance = 0, balHidden = false;
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
    return `<div class="plan-tab${p.plan_id === activePlanId ? ' active' : ''}${isOverdue ? ' overdue-tab' : ''}" onclick="switchPlan('${p.plan_id}')"> ${p.name}${isOverdue ? ' !' : ''}</div>`;
  }).join('') + `<div class="plan-tab add-tab" onclick="openNewPlanModal()">+ New Plan</div>`;
  if (!activePlanId) { document.getElementById('noPlanMsg').style.display = 'block'; document.getElementById('planArea').style.display = 'none'; }
  else { document.getElementById('noPlanMsg').style.display = 'none'; document.getElementById('planArea').style.display = 'block'; await renderPlanDetail(activePlanId); }
}

async function switchPlan(id) { activePlanId = id; await renderCustDash(); }

async function renderPlanDetail(planId) {
  // Fire all 3 queries in parallel instead of sequentially
  const [{ data: plan }, { data: planExtra }, { data: allDeposits }] = await Promise.all([
    db.from('plan_balances').select('*').eq('plan_id', planId).single(),
    db.from('plans').select('regular_contribution,maturity_date').eq('id', planId).single(),
    db.from('transactions').select('amount').eq('plan_id', planId).in('type', ['opening', 'deposit'])
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
  let txs = [], rejDisbs = [];
  try {
    const [r1, r2] = await Promise.all([
      db.from('transactions').select('*').eq('plan_id', planId).order('created_at', { ascending: false }),
      db.from('disbursements').select('*').eq('plan_id', planId).eq('status', 'rejected')
    ]);
    txs = r1.data || []; rejDisbs = r2.data || [];
  } catch (e) { console.warn('tx fetch error:', e); }
  const rejRows = (rejDisbs || []).map(d => ({ id: d.id, type: 'rejected', amount: d.amount, created_at: d.requested_at, ref: d.ref }));
  const allTxs = [...txs, ...rejRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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

async function closePlan() {
  if (!activePlanId) return;
  const { data: pb } = await db.from('plan_balances').select('balance,name').eq('plan_id', activePlanId).single();
  const bal = Number(pb?.balance || 0);
  if (bal > 0) { alert('× Cannot close "' + pb.name + '"\n\nBalance remaining: ' + fmt(bal) + '\n\nPlease withdraw all your money first. Once your balance is ₦0.00, you can close this plan.'); return; }
  if (!confirm('Close "' + pb.name + '"? This will make it inactive. You can reactivate later.')) return;
  showLoading('Closing plan…');
  await db.from('plans').update({ status: 'closed' }).eq('id', activePlanId);
  await audit('delete', getUser().id, 'customer', 'Closed plan "' + (pb.name || '') + '"', null, activePlanId);
  hideLoading(); await renderCustDash();
}
async function reactivatePlan() {
  if (!activePlanId) return;
  showLoading('Reactivating…');
  await db.from('plans').update({ status: 'active' }).eq('id', activePlanId);
  hideLoading(); await renderCustDash();
}
async function permanentlyDeletePlan() {
  if (!activePlanId) return;
  const { data: pb } = await db.from('plan_balances').select('balance,name').eq('plan_id', activePlanId).single();
  if (!confirm('PERMANENTLY delete "' + (pb?.name || '') + '"? This cannot be undone.')) return;
  showLoading('Deleting…');
  await db.from('plans').update({ status: 'deleted' }).eq('id', activePlanId);
  hideLoading(); activePlanId = null; await renderCustDash();
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
  if (!plans?.length) { alert('No active plans to withdraw from'); return; }
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
  const user = getUser(); const ref = genRef();
  showLoading('Submitting request…');
  try {
    const { error: insErr } = await db.from('disbursements').insert({ customer_id: user.id, plan_id: planId, type: 'withdrawal', amount: +amtVal, reason, ref, status: 'pending', stage_history: [{ stage: 'pending', timestamp: new Date().toISOString(), by: user.id }] });
    if (insErr) throw insErr;
    await checkExcessWithdrawal(user.id);
    await audit('payout', user.id, 'customer', `Withdrawal request of ${fmt(+amtVal)} — PENDING — Ref: ${ref}`, +amtVal, planId);
    setMsg('wdMsg', '<div class="msg-ok"> Request submitted! A representative will approve it shortly.</div>');
    setTimeout(() => { closeModal('withdrawalModal'); setMsg('wdMsg', ''); document.getElementById('wdAmt').value = ''; document.getElementById('wdReason').value = ''; }, 2500);
  } catch (e) {
    console.error('Withdrawal request failed:', e);
    setMsg('wdMsg', `<div class="msg-err">Could not submit request: ${e.message || 'Unknown error. Please try again.'}</div>`);
  } finally {
    hideLoading();
  }
}

function milAct(act) { closeModal('milestoneModal'); if (act === 'payout') openWithdrawalModal(); else if (act === 'extend') alert('Contact your representative to extend the plan date.'); else if (act === 'increase') openNewPlanModal(); }

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
  const user = getUser(); const pinHash = await hashPin(pin);
  // Fix 8: verify PIN server-side via RPC — never fetch hash to frontend
  const { data: hasPin } = await db.from(
    user.role === 'representative' ? 'representatives' : 'customers'
  ).select('payment_pin_hash').eq('id', user.id).single();
  if (!hasPin?.payment_pin_hash) {
    // No PIN set yet — let them through and prompt setup
    closeModal('payPinModal');
    if (_payPinCallback) { _payPinCallback(); _payPinCallback = null; }
    return;
  }
  const { data: valid, error } = await db.rpc('verify_payment_pin', {
    p_customer_id: user.id,
    p_pin_hash: pinHash
  });
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

let calState = { yr: 0, mo: 0, covered: new Set(), missed: new Set(), payouts: new Set() };

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
  const totalDaysCovered = Math.floor(totalDeposited / regularAmt);

  calState.covered = new Set();
  calState.missed = new Set();
  calState.payouts = new Set();

  paidDisbs.forEach(d => {
    if (d.confirmed_at) {
      calState.payouts.add(dateKey(new Date(d.confirmed_at)));
    }
  });

  const streakWalker = new Date(planStart);
  for (let i = 0; i < totalDaysCovered; i++) {
    const ds = dateKey(streakWalker);
    calState.covered.add(ds);
    streakWalker.setDate(streakWalker.getDate() + 1);
  }

  const missWalker = new Date(streakWalker);
  while (missWalker < today) {
    calState.missed.add(dateKey(missWalker));
    missWalker.setDate(missWalker.getDate() + 1);
  }

  calState.yr = today.getFullYear();
  calState.mo = today.getMonth();
  drawCal();
}

function drawCal() {
  const { yr, mo, covered, missed, payouts } = calState;
  const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const todayStr = dateKey(new Date());
  const firstDay = new Date(yr, mo, 1).getDay();
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
    const isMissed = missed.has(ds);
    const isToday = ds === todayStr;
    let cls = 'cal-cell';
    let title = '';
    if (isPayout) { cls += ' c-payout'; title = 'Withdrawal day'; }
    else if (isCovered) { cls += ' c-green'; title = 'Paid'; }
    else if (isMissed) { cls += ' c-red'; title = 'Missed'; }
    else { cls += ' c-grey'; }
    if (isToday) cls += ' c-today';
    tds.push(`<td class="${cls}" title="${title}">${d}</td>`);
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
  if (!wrap) return;
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
    const lbl = tx.type === 'opening' ? 'Opening' : tx.type === 'deposit' ? 'Deposit' : tx.type === 'payout' ? 'Payout' : 'Rejected';
    const badge = `<span style="background:${isIn ? '#d1fae5' : '#fee2e2'};color:${isIn ? '#065f46' : '#991b1b'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;">${tx.type}</span>`;
    return `<div class="tx-row">
     <div class="tx-ico ${isIn ? 'tx-ico-g' : 'tx-ico-r'}">${isIn ? '↓' : '↑'}</div>
     <div class="tx-body"><div class="tx-name">${lbl}${tx._planName ? ' · ' + tx._planName : ''}</div><div class="tx-dt">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)}</div><div class="tx-ref">${tx.ref || '—'}</div><div style="margin-top:3px;">${badge}</div></div>
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
  el.innerHTML = `
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> My Profile</div>
    <div class="profile-row"><span class="profile-lbl">Full Name</span><span class="profile-val">${u.first_name || ''} ${u.last_name || ''}</span></div>
    <div class="profile-row"><span class="profile-lbl">Phone</span><span class="profile-val">${(u.phone || '').replace('+234', '0')}</span></div>
    <div class="profile-row"><span class="profile-lbl">Email</span><span class="profile-val">${u.email || '—'}</span></div>
    <div class="profile-row"><span class="profile-lbl">Address</span><span class="profile-val">${u.address || '—'}</span></div>
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
  const curHash = await hashPin(cur);
  const { data: chk } = await db.from('customers').select('id').eq('id', u.id).eq('pin_hash', curHash).single();
  if (!chk) { hideLoading(); setMsg('cpPwMsg', '<div class="msg-err">Current password is incorrect</div>'); return; }
  const newHash = await hashPin(nw);
  await db.from('customers').update({ pin_hash: newHash }).eq('id', u.id);
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
  const { data: valid } = await db.rpc('verify_payment_pin', { p_customer_id: u.id, p_pin_hash: curHash });
  if (valid !== true) { hideLoading(); setMsg('cpPinMsg', '<div class="msg-err">Current PIN is incorrect</div>'); return; }
  await db.from('customers').update({ payment_pin_hash: await hashPin(nw) }).eq('id', u.id);
  await audit('login', u.id, 'customer', `Customer ${u.first_name} ${u.last_name} changed their withdrawal PIN`);
  hideLoading(); setMsg('cpPinMsg', '<div class="msg-ok">Withdrawal PIN updated</div>');
  document.getElementById('cpCurPin').value = ''; document.getElementById('cpNewPin').value = '';
}
