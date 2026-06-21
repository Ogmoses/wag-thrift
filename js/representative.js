// ═══════════════════════════════════════════════
// js/representative.js
// REP DASHBOARD STATS · CUSTOMER SEARCH · COLLECTIONS · WITHDRAWAL REQUESTS · PROFILE
// Depends on: js/supabase.js, js/utils.js, js/auth.js (load all first)
// ═══════════════════════════════════════════════

let repFoundCust = null, repSelectedPlan = null;
let _payPinCallback = null;

// ═══════════════════════════════════════════════
// PAYMENT PIN — generic verify-before-action
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
  const tbl = user.role === 'representative' ? 'representatives' : 'customers';
  const { data: row } = await db.from(tbl).select('payment_pin_hash').eq('id', user.id).single();
  if (!row?.payment_pin_hash) { closeModal('payPinModal'); if (_payPinCallback) { _payPinCallback(); _payPinCallback = null; } return; }
  if (row.payment_pin_hash !== pinHash) { setMsg('payPinMsg', '<div class="msg-err">Incorrect PIN. Try again.</div>'); return; }
  closeModal('payPinModal');
  document.getElementById('payPinInp').value = '';
  if (_payPinCallback) { _payPinCallback(); _payPinCallback = null; }
}

// ═══════════════════════════════════════════════
// AGENT RELIABILITY SCORE
// ═══════════════════════════════════════════════
async function getAgentScore(repId) {
  const { data } = await db.from('fraud_flags').select('severity').eq('user_id', repId).eq('resolved', false);
  let score = 100;
  (data || []).forEach(f => { score -= f.severity === 'medium' ? 8 : f.severity === 'high' ? 15 : 3; });
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══════════════════════════════════════════════
// DASHBOARD (representative/dashboard.html)
// ═══════════════════════════════════════════════
async function renderRepDash() {
  if (!db) return;
  const rep = getUser();
  document.getElementById('repAv').textContent = rep.first_name[0].toUpperCase();
  document.getElementById('repName').textContent = rep.first_name + ' ' + rep.last_name;
  document.getElementById('repCode').textContent = 'Code: ' + rep.rep_id;
  const today = new Date().toISOString().split('T')[0];
  const { data: todayTx } = await db.from('transactions').select('amount').eq('agent_id', rep.id).in('type', ['deposit', 'opening']).gte('created_at', today);
  const todayAmt = (todayTx || []).reduce((s, t) => s + Number(t.amount), 0);
  document.getElementById('repTodayAmt').textContent = fmt(todayAmt);
  document.getElementById('repTodayCnt').textContent = (todayTx || []).length + ' transaction' + ((todayTx || []).length !== 1 ? 's' : '');
  const { data: allTx } = await db.from('transactions').select('amount').eq('agent_id', rep.id).in('type', ['deposit', 'opening']);
  document.getElementById('repAllAmt').textContent = fmt((allTx || []).reduce((s, t) => s + Number(t.amount), 0));
  document.getElementById('repConfirmed').textContent = rep.confirmed_count || 0;
  const score = await getAgentScore(rep.id);
  document.getElementById('repScoreVal').textContent = score + '%';
  document.getElementById('repScoreVal').style.color = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)';
  document.getElementById('repScoreLbl').textContent = score >= 80 ? 'excellent' : score >= 60 ? 'good' : 'needs review';
  loadRepTxPreview();
}

// ── Recent deposits preview (used on dashboard.html)
let _repTxCache = [], _repCustMap = {};
async function loadRepTxPreview() {
  if (!db) return;
  const rep = getUser();
  const { data: txs } = await db.from('transactions').select('*').eq('agent_id', rep.id).order('created_at', { ascending: false });
  _repTxCache = txs || [];
  const custIds = [...new Set(_repTxCache.map(t => t.customer_id).filter(Boolean))];
  if (custIds.length) {
    const { data: custs } = await db.from('customers').select('id,first_name,last_name').in('id', custIds);
    (custs || []).forEach(cu => { _repCustMap[cu.id] = cu.first_name + ' ' + cu.last_name; });
  }
  const el = document.getElementById('repTxPreview'); if (!el) return;
  if (!_repTxCache.length) { el.innerHTML = '<div class="tx-empty">No deposits yet</div>'; return; }
  el.innerHTML = _repTxCache.slice(0, 3).map(tx => {
    const isPayout = tx.type === 'payout';
    const isRejected = tx.type === 'rejected_disb';
    const isReserved = tx.ref?.startsWith('RESERVE-');
    const isConfirmedPaid = isReserved && tx.method === 'Cash';
    const isIn = !isPayout && !isRejected;
    const label = tx.type === 'opening' ? 'Opening'
      : isPayout ? (isConfirmedPaid ? 'Paid' : isReserved ? 'Withdrawal (pending)' : 'Payout')
      : isRejected ? 'Rejected Withdrawal'
      : 'Deposit';
    const refDisplay = isReserved ? (isConfirmedPaid ? 'Cash delivered' : 'Withdrawal request') : (tx.ref || '—');
    return `<div class="tx-row">
 <div class="tx-ico ${isIn || isConfirmedPaid ? 'tx-ico-g' : 'tx-ico-r'}">${isIn ? '↓' : '↑'}</div>
 <div class="tx-body">
 <div class="tx-name">${_repCustMap[tx.customer_id] || 'Customer'}</div>
 <div class="tx-dt">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)} · ${label}</div>
 <div class="tx-ref">${refDisplay}</div>
 </div>
 <div class="${isIn ? 'tx-amt-g' : 'tx-amt-r'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</div>
 </div>`;
  }).join('');
  if (_repTxCache.length > 3) el.innerHTML += `<div style="text-align:center;padding:8px 0;"><a href="collections.html" style="background:none;border:none;color:var(--blue);font-size:13px;font-weight:700;text-decoration:none;">+ ${_repTxCache.length - 3} more →</a></div>`;
}

// ═══════════════════════════════════════════════
// CUSTOMER SEARCH + COLLECT DEPOSIT + PER-CUSTOMER REQUESTS
// (representative/customer-search.html)
// ═══════════════════════════════════════════════
async function repDoSearch() {
  if (!dbReady()) return;
  const raw = document.getElementById('repSearchInp').value.trim(); setMsg('repSearchMsg', '');
  if (!raw) { setMsg('repSearchMsg', '<div class="msg-err">Please enter a phone number</div>'); return; }
  const normPh = normPhone(raw); showLoading('Searching…');
  let { data: cust } = await db.from('customers').select('*').eq('phone', normPh).single();
  if (!cust) { const { data: c2 } = await db.from('customers').select('*').ilike('phone', '%' + normPh.slice(-9)); cust = c2?.[0] || null; }
  hideLoading();
  if (!cust) { setMsg('repSearchMsg', '<div class="msg-err">Customer not found. Check the phone number.</div>'); document.getElementById('repCustCard').style.display = 'none'; return; }
  repFoundCust = cust;
  document.getElementById('repCustAv').textContent = cust.first_name[0].toUpperCase();
  document.getElementById('repCustNm').textContent = cust.first_name + ' ' + cust.last_name;
  document.getElementById('repCustPh').textContent = cust.phone;
  const { data: plans } = await db.from('plan_balances').select('*').eq('customer_id', cust.id).eq('status', 'active').neq('status', 'deleted');
  const dd = document.getElementById('repPlanDd');
  dd.innerHTML = '<option value="">— Select a plan —</option>';
  (plans || []).forEach(p => dd.innerHTML += `<option value="${p.plan_id}" data-bal="${p.balance}" data-tgt="${p.target_amount}">${p.name} — ${fmt(p.balance)}</option>`);
  if (plans?.length === 1) { dd.value = plans[0].plan_id; repOnPlanChange(); } else document.getElementById('repPlanDetails').style.display = 'none';
  await loadRepDisbList(cust.id);
  document.getElementById('repCustCard').style.display = 'block';
}

async function loadRepDisbList(custId) {
  const { data: disbs } = await db.from('disbursements').select('*').eq('customer_id', custId).in('status', ['pending', 'reviewed', 'approved']);
  const dList = document.getElementById('repDisbList');
  dList.innerHTML = renderDisbCards(disbs || []);
}

function renderDisbCards(disbs) {
  if (!disbs.length) return '<div style="text-align:center;color:var(--sub);padding:16px;font-size:12px;">No pending withdrawals</div>';
  const stages = ['pending', 'reviewed', 'approved', 'paid'];
  return disbs.map(d => {
    const curIdx = stages.indexOf(d.status);
    const isPending = d.status === 'pending';
    const isReviewed = d.status === 'reviewed';
    const isApproved = d.status === 'approved';
    let actionHtml = '';
    if (isPending || isReviewed) {
      const msg = isPending
        ? '<strong>Awaiting Admin Review</strong> — A Super Admin must review this request first.'
        : '<strong>Awaiting Admin Approval</strong> — Admin has reviewed, now needs to approve.';
      actionHtml = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:9px 12px;font-size:11px;color:#92400e;display:flex;align-items:center;gap:6px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg><span>${msg}</span></div>`;
    } else if (isApproved) {
      actionHtml = `<div class="dis-acts" style="grid-template-columns:1fr;"><button class="btn-sm btn-sm-blue" style="padding:11px;font-size:13px;" onclick="doMarkPaid('${d.id}','${d.plan_id}',${d.amount},'${d.customer_id}')">Mark as Paid</button></div>`;
    }
    return `<div class="dis-card"><div class="dis-type">${d.type === 'withdrawal' ? 'Withdrawal' : 'Milestone'}</div><div class="dis-amt">${fmt(d.amount)}</div><div class="dis-stage-bar">${stages.map((s, i) => `<div class="stage-step"><div class="stage-dot ${i < curIdx ? 'done' : i === curIdx ? 'active' : ''}"></div><div class="stage-label">${s}</div></div>`).join('')}</div><div class="dis-reason">${d.reason || 'No reason provided'}</div>${actionHtml}</div>`;
  }).join('');
}

async function repOnPlanChange() {
  const dd = document.getElementById('repPlanDd'); const opt = dd.options[dd.selectedIndex];
  repSelectedPlan = dd.value ? { id: dd.value, balance: +opt.dataset.bal, target: +opt.dataset.tgt } : null;
  const det = document.getElementById('repPlanDetails');
  if (!repSelectedPlan) { det.style.display = 'none'; return; }
  document.getElementById('rpBal').textContent = fmt(repSelectedPlan.balance);
  let regContrib = 0, createdAt = null, totalDeposited = 0;
  if (db) {
    const [{ data: pl }, { data: deposits }] = await Promise.all([
      db.from('plans').select('regular_contribution,created_at').eq('id', repSelectedPlan.id).single(),
      db.from('transactions').select('amount').eq('plan_id', repSelectedPlan.id).in('type', ['opening', 'deposit'])
    ]);
    regContrib = pl?.regular_contribution || 0;
    createdAt = pl?.created_at || null;
    totalDeposited = (deposits || []).reduce((s, t) => s + Number(t.amount), 0);
  }
  document.getElementById('rpTgt').textContent = regContrib > 0 ? fmt(regContrib) : 'Not set';

  // Missed contributions — uses TOTAL DEPOSITED (not current balance), same as
  // the customer dashboard/calendar. Withdrawals reduce balance but shouldn't
  // make past paid days look "missed" — only deposits count as days covered.
  const missedEl = document.getElementById('rpMissed');
  if (missedEl) {
    if (regContrib > 0 && createdAt) {
      const start = new Date(createdAt); start.setHours(0, 0, 0, 0);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const calendarDaysElapsed = Math.max(0, Math.floor((today - start) / (1000 * 60 * 60 * 24)));
      const daysCovered = Math.floor(totalDeposited / regContrib);
      const missed = Math.max(0, calendarDaysElapsed - daysCovered);
      missedEl.textContent = missed === 0 ? 'None' : `${missed} day${missed !== 1 ? 's' : ''}`;
      missedEl.style.color = missed === 0 ? 'var(--green)' : missed < 3 ? 'var(--orange)' : 'var(--red)';
    } else {
      missedEl.textContent = '—';
      missedEl.style.color = '';
    }
  }
  det.style.display = 'block';
}

function openCollectModal() {
  if (!repFoundCust) { alert('Search for a customer first'); return; }
  if (!repSelectedPlan) { alert('Please select a plan first'); return; }
  requirePayPin('Payment PIN', 'Enter your payment PIN to save this deposit.', () => showModal('collectModal'));
}

async function doCollection() { guardedSubmit('collection', () => _doCollection()); }
async function _doCollection() {
  const amtVal = document.getElementById('colAmt').value.trim(), method = document.getElementById('colMethod').value, notes = document.getElementById('colNotes').value.trim();
  if (!amtVal || +amtVal <= 0) { setMsg('colMsg', '<div class="msg-err">Enter a valid amount</div>'); return; }
  if (!method) { setMsg('colMsg', '<div class="msg-err">Select a payment method</div>'); return; }
  const amt = +amtVal; const rep = getUser(); const ref = genRef();
  let regContrib = 0;
  if (db && repSelectedPlan) { const { data: pl } = await db.from('plans').select('regular_contribution').eq('id', repSelectedPlan.id).single(); regContrib = Number(pl?.regular_contribution || 0); }
  if (regContrib > 0 && amt % regContrib !== 0) {
    const multiples = [1, 2, 3].map(n => fmt(regContrib * n)).join(', ');
    setMsg('colMsg', `<div class="msg-err">Amount must be a multiple of the regular contribution (${fmt(regContrib)}).<br>e.g. ${multiples}…</div>`);
    return;
  }
  showLoading('Saving deposit…');
  const { count: txCount } = await db.from('transactions').select('*', { count: 'exact', head: true }).eq('plan_id', repSelectedPlan.id);
  const txType = (txCount === 0) ? 'opening' : 'deposit';
  await db.from('transactions').insert({ ref, type: txType, amount: amt, plan_id: repSelectedPlan.id, customer_id: repFoundCust.id, agent_id: rep.id, method, notes });
  await db.from('representatives').update({ confirmed_count: (rep.confirmed_count || 0) + 1 }).eq('id', rep.id);
  await checkLargeCollection(amt, rep.id, repSelectedPlan.id);
  await audit('deposit', rep.id, 'representative', `Collected ${fmt(amt)} for ${repFoundCust.first_name} ${repFoundCust.last_name} — Ref: ${ref}`, amt, repSelectedPlan.id);
  const { data: newBal } = await db.from('plan_balances').select('balance').eq('plan_id', repSelectedPlan.id).single();
  hideLoading(); closeModal('collectModal');
  showReceipt(amt, repSelectedPlan, rep, repFoundCust, ref, method, newBal?.balance || 0);
  setUser({ ...rep, confirmed_count: (rep.confirmed_count || 0) + 1 });
  document.getElementById('colAmt').value = ''; document.getElementById('colMethod').value = ''; document.getElementById('colNotes').value = '';
  await repDoSearch();
}

function showReceipt(amount, plan, rep, cust, ref, method, newBal) {
  const now = new Date();
  document.getElementById('receiptContent').innerHTML = `
 <div class="receipt-wrap">
 <div class="receipt-logo"></div>
 <div class="receipt-title">WAG Deposit Receipt</div>
 <div class="receipt-amount">${fmt(amount)}</div>
 <div class="receipt-plan">${plan.name || 'Savings Plan'}</div>
 <div class="receipt-row"><span class="receipt-lbl">Date</span><span class="receipt-val">${fmtDate(now.toISOString())}</span></div>
 <div class="receipt-row"><span class="receipt-lbl">Time</span><span class="receipt-val">${fmtTime(now.toISOString())}</span></div>
 <div class="receipt-row"><span class="receipt-lbl">Agent ID</span><span class="receipt-val">#${rep.rep_id}</span></div>
 <div class="receipt-row"><span class="receipt-lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:inline-block;vertical-align:middle;margin-right:5px;"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Customer</span><span class="receipt-val">${cust.first_name} ${cust.last_name}</span></div>
 <div class="receipt-row"><span class="receipt-lbl">Method</span><span class="receipt-val">${method}</span></div>
 <div class="receipt-row"><span class="receipt-lbl">New Balance</span><span class="receipt-val">${fmt(newBal)}</span></div>
 <div class="receipt-ref">${ref}</div>
 </div>`;
  showModal('receiptModal');
}

// ═══════════════════════════════════════════════
// WITHDRAWAL REQUEST ACTIONS — approve/reject (used by both
// customer-search.html (per-customer) and requests.html (global list))
// ═══════════════════════════════════════════════
// NOTE: doApproveDisb/_doApproveDisb removed — reps no longer approve
// withdrawals directly (that bypassed the balance-deduction logic in
// approve_disbursement RPC). Only admin approves now; reps mark paid
// after cash delivery via doMarkPaid/_doMarkPaid below.

// Rep marks paid after physically delivering cash to customer
async function doMarkPaid(disbId, planId, amount, custId) { guardedSubmit('markPaid_' + disbId, () => _doMarkPaid(disbId, planId, amount, custId)); }
async function _doMarkPaid(disbId, planId, amount, custId) {
  const { data: disbCheck } = await db.from('disbursements').select('status,reserve_ref').eq('id', disbId).single();
  if (!disbCheck || disbCheck.status !== 'approved') {
    alert('This withdrawal must be in approved status before marking as paid.');
    return;
  }
  const { data: cust } = await db.from('customers').select('first_name,last_name').eq('id', custId).single();
  if (!confirm(`Confirm cash of ${fmt(amount)} has been physically delivered to ${cust?.first_name || 'customer'}?`)) return;
  showLoading('Confirming delivery…');
  // Goes through a SECURITY DEFINER RPC rather than direct table updates —
  // reps only have READ access to disbursements/transactions under RLS,
  // so a direct .update() here would silently affect 0 rows.
  const { data: result, error } = await db.rpc('mark_disbursement_paid', { p_disbursement_id: disbId });
  if (error || result?.ok === false) {
    hideLoading();
    alert('Failed to mark as paid: ' + (result?.error || error?.message || 'Unknown error'));
    return;
  }
  hideLoading();
  alert(`Payment Complete\nCash delivered to ${cust?.first_name || 'customer'}`);
  // Refresh cached profile so confirmed_count (updated server-side by the
  // RPC) reflects on the dashboard without needing a full re-login.
  if (typeof verifyRoleFromDB === 'function') await verifyRoleFromDB('representative');
  if (typeof repFoundCust !== 'undefined' && repFoundCust) await repDoSearch();
  if (document.getElementById('repAllRequestsList')) await loadAllRepRequests();
}

async function doRejectDisb(disbId, custId) { await guardedAction('rejectDisb_' + disbId, () => _doRejectDisb(disbId, custId)); }
async function _doRejectDisb(disbId, custId) {
  if (!confirm('Reject this withdrawal request? This cannot be undone.')) return;
  showLoading('Rejecting…');
  const { data: result, error } = await db.rpc('rep_reject_disbursement', { p_disbursement_id: disbId });
  hideLoading();
  if (error || result?.ok === false) {
    alert('Failed to reject: ' + (result?.error || error?.message || 'Unknown error'));
    return;
  }
  alert('Withdrawal rejected');
  if (typeof repFoundCust !== 'undefined' && repFoundCust) await repDoSearch();
  if (document.getElementById('repAllRequestsList')) await loadAllRepRequests();
}

// ═══════════════════════════════════════════════
// ALL WITHDRAWAL REQUESTS (representative/requests.html)
// Platform-wide list of customer-submitted withdrawal requests
// ═══════════════════════════════════════════════
async function loadAllRepRequests() {
  const el = document.getElementById('repAllRequestsList');
  if (!el) return;
  el.innerHTML = '<div class="tx-empty">Loading…</div>';
  const { data: disbs } = await db.from('disbursements').select('*').in('status', ['pending', 'reviewed', 'approved']).order('requested_at', { ascending: false });
  if (!disbs?.length) { el.innerHTML = '<div class="tx-empty">No pending withdrawal requests</div>'; return; }
  const custIds = [...new Set(disbs.map(d => d.customer_id).filter(Boolean))];
  let custMap = {};
  if (custIds.length) {
    const { data: custs } = await db.from('customers').select('id,first_name,last_name,phone').in('id', custIds);
    (custs || []).forEach(c => custMap[c.id] = c);
  }
  el.innerHTML = disbs.map(d => {
    const cu = custMap[d.customer_id] || {};
    const cards = renderDisbCards([d]);
    return `<div class="wcard" style="margin-bottom:10px;padding:10px;">
      <div class="dis-cust-name">${cu.first_name || 'Customer'} ${cu.last_name || ''}</div>
      <div style="font-size:11px;color:var(--sub);margin-bottom:8px;">${cu.phone || ''}</div>
      ${cards}
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════
// MY DEPOSITS / TRANSACTION HISTORY (representative/collections.html)
// ═══════════════════════════════════════════════
let _repTxAll = [], _repCustMapHist = {};
async function loadRepTxPage() {
  const u = getUser(); if (!u) return;
  const el = document.getElementById('repTxSubList');
  el.innerHTML = '<div class="tx-empty">Loading…</div>';
  const { data: allTx } = await db.from('transactions').select('*').eq('agent_id', u.id).order('created_at', { ascending: false });
  const custIds = [...new Set((allTx || []).map(t => t.customer_id).filter(Boolean))];
  let cMap = {};
  if (custIds.length) {
    const { data: custs } = await db.from('customers').select('id,first_name,last_name').in('id', custIds);
    (custs || []).forEach(cu => cMap[cu.id] = cu.first_name + ' ' + cu.last_name);
  }
  const { data: rd } = await db.from('disbursements').select('*').eq('confirmed_by', u.id).eq('status', 'rejected');
  const rejRows = (rd || []).map(d => ({ id: d.id, type: 'rejected_disb', amount: d.amount, created_at: d.requested_at || d.created_at, ref: d.ref, customer_id: d.customer_id }));
  _repTxAll = [...(allTx || []), ...rejRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  _repCustMapHist = cMap;
  renderRepTxList();
}
function renderRepTxList() {
  const el = document.getElementById('repTxSubList');
  const cat = document.getElementById('repTxCatFilter')?.value || 'all';
  const filtered = cat === 'all' ? _repTxAll : _repTxAll.filter(t => t.type === cat);
  if (!filtered.length) { el.innerHTML = '<div class="tx-empty">No transactions yet</div>'; return; }
  el.innerHTML = filtered.map(tx => {
    const isPayout = tx.type === 'payout';
    const isRejected = tx.type === 'rejected_disb';
    const isReserved = tx.ref?.startsWith('RESERVE-');
    const isConfirmedPaid = isReserved && tx.method === 'Cash';
    const isIn = !isPayout && !isRejected;
    const lbl = tx.type === 'opening' ? 'Opening'
      : isPayout ? (isConfirmedPaid ? 'Paid' : isReserved ? 'Withdrawal (pending)' : 'Payout')
      : isRejected ? 'Rejected Withdrawal'
      : 'Deposit';
    const refDisplay = isReserved ? (isConfirmedPaid ? 'Cash delivered' : 'Withdrawal request') : (tx.ref || '—');
    const badgeText = isConfirmedPaid ? 'paid' : isReserved ? 'pending' : tx.type;
    const badge = `<span style="background:${isIn ? '#d1fae5' : isConfirmedPaid ? '#d1fae5' : '#fee2e2'};color:${isIn ? '#065f46' : isConfirmedPaid ? '#065f46' : '#991b1b'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;">${badgeText}</span>`;
    return `<div class="tx-row">
     <div class="tx-ico ${isIn || isConfirmedPaid ? 'tx-ico-g' : 'tx-ico-r'}">${isIn ? '↓' : '↑'}</div>
     <div class="tx-body"><div class="tx-name">${_repCustMapHist[tx.customer_id] || 'Customer'}</div><div class="tx-dt">${fmtDate(tx.created_at)} · ${fmtTime(tx.created_at)} · ${lbl}</div><div class="tx-ref">${refDisplay}</div><div style="margin-top:3px;">${badge}</div></div>
     <div class="${isIn ? 'tx-amt-g' : 'tx-amt-r'}">${isIn ? '+' : '-'}${fmt(tx.amount)}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════
// PROFILE (representative/settings.html)
// ═══════════════════════════════════════════════
function buildRepProfilePage() {
  const u = getUser(); if (!u) return;
  const el = document.getElementById('repProfileContent'); if (!el) return;
  el.innerHTML = `
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg> Agent Profile</div>
    <div class="profile-row"><span class="profile-lbl">Full Name</span><span class="profile-val">${u.first_name || ''} ${u.last_name || ''}</span></div>
    <div class="profile-row"><span class="profile-lbl">Agent ID</span><span class="profile-val">${u.rep_id || '—'}</span></div>
    <div class="profile-row"><span class="profile-lbl">Phone</span><span class="profile-val">${(u.phone || '').replace('+234', '0')}</span></div>
    <div class="profile-row"><span class="profile-lbl">Email</span><span class="profile-val">${u.email || '—'}</span></div>
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
     <div class="pin-wrap"><input type="password" id="rpCurPw" class="form-inp" placeholder="Current password" maxlength="100"><button type="button" class="pw-eye" onclick="togglePw('rpCurPw')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="mform-group"><label class="form-lbl">New Password</label>
     <div class="pin-wrap"><input type="password" id="rpNewPw" class="form-inp" placeholder="New password (min 6)" maxlength="100"><button type="button" class="pw-eye" onclick="togglePw('rpNewPw')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div id="rpPwMsg"></div>
    <button class="btn btn-blue" style="margin-bottom:10px;" onclick="changeRepPassword()">Update Password</button>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg> Change Payment PIN</div>
    <div class="mform-group"><label class="form-lbl">Current Payment PIN</label>
     <div class="pin-wrap"><input type="password" id="rpCurPin" class="form-inp" placeholder="Current PIN" maxlength="6" inputmode="numeric"><button type="button" class="pw-eye" onclick="togglePw('rpCurPin')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="mform-group"><label class="form-lbl">New Payment PIN</label>
     <div class="pin-wrap"><input type="password" id="rpNewPin" class="form-inp" placeholder="4–6 digits" maxlength="6" inputmode="numeric"><button type="button" class="pw-eye" onclick="togglePw('rpNewPin')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div id="rpPinMsg"></div>
    <button class="btn btn-blue" style="margin-bottom:10px;" onclick="changeRepPayPin()">Update Payment PIN</button>
   </div>
   <div class="profile-card">
    <div class="profile-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Account</div>
    <button class="btn" style="background:#fee2e2;color:var(--red);margin-bottom:0;" onclick="doLogout()">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
     Sign Out
    </button>
   </div>`;
}

async function changeRepPassword() {
  const u = getUser();
  const cur = document.getElementById('rpCurPw').value;
  const nw = document.getElementById('rpNewPw').value;
  if (!cur || !nw) { setMsg('rpPwMsg', '<div class="msg-err">Fill in both fields</div>'); return; }
  if (nw.length < 6) { setMsg('rpPwMsg', '<div class="msg-err">New password must be at least 6 characters</div>'); return; }
  showLoading('Verifying…');
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user?.email) { hideLoading(); setMsg('rpPwMsg', '<div class="msg-err">Session expired. Please sign in again.</div>'); return; }
  const { error: verifyErr } = await db.auth.signInWithPassword({ email: session.user.email, password: cur });
  if (verifyErr) { hideLoading(); setMsg('rpPwMsg', '<div class="msg-err">Current password is incorrect</div>'); return; }
  const { error: updateErr } = await db.auth.updateUser({ password: nw });
  if (updateErr) { hideLoading(); setMsg('rpPwMsg', `<div class="msg-err">${updateErr.message}</div>`); return; }
  await audit('login', u.id, 'representative', `Agent ${u.first_name} ${u.last_name} changed their password`);
  hideLoading(); setMsg('rpPwMsg', '<div class="msg-ok">Password updated</div>');
  document.getElementById('rpCurPw').value = ''; document.getElementById('rpNewPw').value = '';
}

async function changeRepPayPin() {
  const u = getUser();
  const cur = document.getElementById('rpCurPin').value;
  const nw = document.getElementById('rpNewPin').value;
  if (!cur || !nw) { setMsg('rpPinMsg', '<div class="msg-err">Fill in both fields</div>'); return; }
  if (!/^\d{4,6}$/.test(nw)) { setMsg('rpPinMsg', '<div class="msg-err">PIN must be 4–6 digits</div>'); return; }
  showLoading('Verifying…');
  const curHash = await hashPin(cur);
  const { data: chk } = await db.from('representatives').select('id').eq('id', u.id).eq('payment_pin_hash', curHash).single();
  if (!chk) { hideLoading(); setMsg('rpPinMsg', '<div class="msg-err">Current PIN is incorrect</div>'); return; }
  await db.from('representatives').update({ payment_pin_hash: await hashPin(nw) }).eq('id', u.id);
  hideLoading(); setMsg('rpPinMsg', '<div class="msg-ok">Payment PIN updated</div>');
  document.getElementById('rpCurPin').value = ''; document.getElementById('rpNewPin').value = '';
}
