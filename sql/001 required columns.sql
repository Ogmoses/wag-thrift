-- ═══════════════════════════════════════════════
-- WAG Enterprises — Required Schema Additions
-- Run in: Supabase Dashboard → SQL Editor → New Query
--
-- These columns were already referenced by the original app
-- (see showMigrationAlert in admin.js) but may not exist yet
-- on every deployment. All statements are IF NOT EXISTS / safe
-- to re-run.
-- ═══════════════════════════════════════════════

-- Customers: lifecycle status + payment PIN
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_pin_hash TEXT;

-- Representatives: lifecycle status + payment PIN + confirmed_count
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS payment_pin_hash TEXT;
ALTER TABLE representatives ADD COLUMN IF NOT EXISTS confirmed_count INTEGER DEFAULT 0;

-- Plans: status (active/closed/deleted) + regular contribution
ALTER TABLE plans ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS regular_contribution NUMERIC DEFAULT 1000;

-- Disbursements: stage history + reviewed metadata
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS confirmed_by UUID;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS stage_history JSONB;

-- pin_attempts (lockout tracking)
CREATE TABLE IF NOT EXISTS pin_attempts (
  phone TEXT PRIMARY KEY,
  attempts INTEGER DEFAULT 0,
  last_attempt TIMESTAMPTZ
);

-- password_resets (forgot-password flow)
CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  used BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- fraud_flags (fraud detection)
CREATE TABLE IF NOT EXISTS fraud_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  user_id TEXT,
  plan_id UUID,
  description TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- activation_tokens (rep registration gate)
CREATE TABLE IF NOT EXISTS activation_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  used BOOLEAN DEFAULT false,
  used_by UUID,
  used_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ DEFAULT now()
);

-- audit_log (already used heavily — ensure shape matches)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  user_id TEXT,
  user_role TEXT,
  description TEXT,
  amount NUMERIC,
  plan_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════
-- Enable Realtime (required for admin.js live updates)
-- Run once per table — Supabase Dashboard → Database → Replication
-- or via SQL:
-- ═══════════════════════════════════════════════
-- ALTER PUBLICATION supabase_realtime ADD TABLE disbursements;
-- ALTER PUBLICATION supabase_realtime ADD TABLE transactions;
-- ALTER PUBLICATION supabase_realtime ADD TABLE audit_log;
-- ALTER PUBLICATION supabase_realtime ADD TABLE fraud_flags;
-- ALTER PUBLICATION supabase_realtime ADD TABLE customers;
-- ALTER PUBLICATION supabase_realtime ADD TABLE representatives;
-- ALTER PUBLICATION supabase_realtime ADD TABLE plans;
