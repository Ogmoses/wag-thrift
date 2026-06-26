// ═══════════════════════════════════════════════
// js/supabase.js
// SUPABASE + EMAILJS CONFIGURATION & CLIENT INITIALISATION
// Loaded on every page (after the Supabase/EmailJS CDN scripts).
// ═══════════════════════════════════════════════

// STEP 1: Replace these with YOUR Supabase project details
// Find them at: Supabase > Project Settings > API
const SUPABASE_URL = 'https://rrrwzximztwrctbasgto.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJycnd6eGltenR3cmN0YmFzZ3RvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDc2ODksImV4cCI6MjA5NTgyMzY4OX0.8KNIalAkbIihTB1KesPebbKkBM2p8FLB1WGyKW-3OVA';

// STEP 2a: Cloudflare Worker URL — set this once your Worker is deployed.
// Format: 'https://wag-api.<your-subdomain>.workers.dev'
// Leave as null to fall back to EmailJS for verification emails.
const WORKER_URL = null; // e.g. 'https://wag-api.ogmoses.workers.dev'

// STEP 2b: EmailJS credentials (fallback while Worker isn't deployed yet)
const EMAILJS_PUBLIC_KEY = 'uh_tr5EcVjvujnnfJ';
const EMAILJS_SERVICE_ID = 'service_a8zgp0k';
const EMAILJS_VERIFY_TMPL = 'template_9o3yvr8';
const EMAILJS_RESET_TMPL = 'template_z0pk61a';

// ═══════════════════════════════════════════════
// SUPABASE CLIENT
// ═══════════════════════════════════════════════
const { createClient } = supabase;
let db;
try {
  if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_') || !SUPABASE_ANON || SUPABASE_ANON.includes('YOUR_')) {
    throw new Error('Supabase credentials not configured yet');
  }
  db = createClient(SUPABASE_URL, SUPABASE_ANON);
} catch (e) {
  console.warn('Supabase:', e.message);
  // App UI still works — only database calls will fail until credentials are added
}

function dbReady() {
  if (!db) {
    alert('! Database not connected.\n\nPlease add your Supabase URL and key to js/supabase.js.');
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════
// EMAILJS
// ═══════════════════════════════════════════════
function initEmailJS() {
  if (typeof emailjs !== 'undefined' && !EMAILJS_PUBLIC_KEY.includes('YOUR_')) {
    emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
  }
}

async function sendVerificationEmail(toEmail, toName, code) {
  // Prefer the Cloudflare Worker (keeps Resend API key server-side).
  // Falls back to EmailJS if Worker isn't deployed yet.
  if (WORKER_URL) {
    try {
      const res = await fetch(`${WORKER_URL}/api/send-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toEmail, toName, code })
      });
      const data = await res.json();
      return res.ok ? { ok: true } : { error: data.error || 'Failed to send email' };
    } catch (e) {
      console.error('Worker verification email error:', e);
      return { error: e.message };
    }
  }
  // EmailJS fallback
  if (EMAILJS_PUBLIC_KEY.includes('YOUR_')) return { demo: true };
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_VERIFY_TMPL, {
      to_email: toEmail, to_name: toName, code, app_name: 'WAG Enterprises'
    });
    return { ok: true };
  } catch (e) {
    console.error('EmailJS error:', e);
    return { error: e.text || e.message || 'Failed to send email' };
  }
}

async function sendResetEmail(toEmail, toName, resetLink) {
  if (EMAILJS_PUBLIC_KEY.includes('YOUR_')) return { demo: true, link: resetLink };
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_RESET_TMPL, {
      to_email: toEmail, to_name: toName, reset_link: resetLink, app_name: 'WAG Enterprises'
    });
    return { ok: true };
  } catch (e) {
    console.error('EmailJS error:', e);
    return { error: e.text || e.message || 'Failed to send email' };
  }
}
