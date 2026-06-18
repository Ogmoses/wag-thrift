-- Fix approve_disbursement — balance is in plan_balances view, not plans table.
-- Also deducts from the correct underlying table.
-- Run in: Supabase Dashboard → SQL Editor → New Query

DROP FUNCTION IF EXISTS approve_disbursement(UUID);

CREATE FUNCTION approve_disbursement(p_disbursement_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_disb  disbursements%ROWTYPE;
  v_bal   NUMERIC;
  v_plan_tbl TEXT;
BEGIN
  -- Lock the disbursement row
  SELECT * INTO v_disb
  FROM disbursements
  WHERE id = p_disbursement_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Disbursement not found');
  END IF;

  IF v_disb.status != 'reviewed' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Must be in reviewed status (current: ' || v_disb.status || ')');
  END IF;

  -- Get balance from plan_balances view
  SELECT balance INTO v_bal
  FROM plan_balances
  WHERE plan_id = v_disb.plan_id;

  IF v_bal IS NULL OR v_bal < v_disb.amount THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Insufficient plan balance. Available: ₦' || COALESCE(v_bal::TEXT, '0'));
  END IF;

  -- Deduct from transactions (insert a negative/payout record to track the deduction)
  -- The plan_balances view recalculates balance from transactions,
  -- so we insert a pending payout transaction to reserve the amount.
  -- This keeps the view consistent.
  INSERT INTO transactions (ref, type, amount, plan_id, customer_id, method, notes)
  VALUES (
    'RESERVE-' || upper(substring(md5(random()::TEXT) FROM 1 FOR 8)),
    'payout',
    v_disb.amount,
    v_disb.plan_id,
    v_disb.customer_id,
    'Pending',
    'Balance reserved — admin approved withdrawal, pending rep delivery'
  );

  -- Mark disbursement as approved
  UPDATE disbursements
  SET status = 'approved'
  WHERE id = p_disbursement_id;

  -- Write audit entry
  INSERT INTO audit_log (action, user_id, user_role, description, amount, plan_id)
  VALUES (
    'approve', 'admin', 'super_admin',
    'Admin approved withdrawal — ₦' || v_disb.amount || ' reserved from plan balance',
    v_disb.amount, v_disb.plan_id
  );

  RETURN jsonb_build_object('ok', true, 'amount_deducted', v_disb.amount);
END;
$$;

GRANT EXECUTE ON FUNCTION approve_disbursement(UUID) TO anon, authenticated, service_role;
