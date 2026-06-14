# WAG Enterprises — Migration Notes & Testing Checklist

## What changed (summary)

|Before                                                          |After                                                                                                    |
|----------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
|`index.html` (2,716 lines, one SPA) + `admin.html` (1,418 lines)|18 page files + 6 JS modules + 4 CSS files                                                               |
|`showView()` / `switchPage()` hide/show sections                |Real navigation — every screen is its own URL                                                            |
|Browser back/forward broken                                     |Back/forward works natively (each `.html` is a real history entry)                                       |
|Hidden admin-PIN trigger inside customer SPA                    |Admin fully isolated under `/admin/`, own session key, own auth module                                   |
|One global `<script>` with ~70 functions                        |Functions split into `auth.js`, `customer.js`, `representative.js`, `admin.js`, `utils.js`, `supabase.js`|

## Final folder structure

```
/
├── index.html              (landing)
├── login.html
├── register.html
├── customer/
│   ├── dashboard.html
│   ├── transactions.html
│   └── settings.html
├── representative/
│   ├── dashboard.html
│   ├── customer-search.html
│   ├── collections.html
│   ├── requests.html
│   └── settings.html
├── admin/
│   ├── login.html
│   ├── dashboard.html      (Overview + Disbursements)
│   ├── users.html           (Customers + Search)
│   ├── representatives.html (Field Agents + Tokens)
│   ├── analytics.html       (Analytics + Fraud Flags)
│   └── settings.html        (Audit Log + Settings)
├── css/
│   ├── shared.css
│   ├── customer.css
│   ├── representative.css
│   └── admin.css
├── js/
│   ├── supabase.js
│   ├── utils.js
│   ├── auth.js
│   ├── customer.js
│   ├── representative.js
│   └── admin.js
└── sql/
    └── 001_required_columns.sql
```

`js/router.js` was folded into the route-guard functions (`requireRole`, `requireAdmin`) in `auth.js`/`admin.js` — since every screen is now a real page, a separate client-side router isn’t needed; the browser’s own navigation/history handles back/forward.

## Routing & auth summary

- **Public**: `index.html`, `login.html`, `register.html` — redirect logged-in users straight to their dashboard.
- **Customer pages**: start with `requireRole(['customer'])`. Wrong role or no session → redirect to `login.html` or the correct dashboard.
- **Representative pages**: start with `requireRole(['representative'])`.
- **Admin pages**: start with `requireAdmin()`. Admin session (`wagAdmin`) is completely separate from `wagUser`; admin pages never load `auth.js`.
- **Suspension polling**: `startSuspendCheck()` runs on every customer/rep page — if an admin suspends the account mid-session, the user is signed out automatically.

## Deployment notes

1. **Run `sql/001_required_columns.sql`** in Supabase SQL Editor — adds `status`, `payment_pin_hash`, `confirmed_count`, and creates `fraud_flags`/`activation_tokens`/`password_resets`/`pin_attempts` if missing.
1. **Enable Realtime** on the tables listed at the bottom of that SQL file (needed for admin live-updating dashboards).
1. **EmailJS**: credentials are in `js/supabase.js` (`EMAILJS_*` constants) — already carried over from your original app.
1. **Admin PIN**: `ADMIN_PIN` in `js/admin.js` — change before going live. `changeAdminPin()` only updates it for the current session (matches original behavior); persist server-side for real deployment.
1. Serve over **HTTPS** — required for `crypto.subtle` (used by `hashPin`).

## Testing checklist

### Public / Auth

- [ ] Landing page role toggle persists into Login/Register
- [ ] Customer login → `customer/dashboard.html`; wrong PIN shows error; 5 fails locks account
- [ ] Rep login → `representative/dashboard.html`
- [ ] Customer registration → email verification code → account created → redirected to login
- [ ] Rep registration with valid token → Agent ID modal → login
- [ ] Forgot password → reset link → `login.html?reset=TOKEN` → new password works

### Navigation / Back-Forward

- [ ] Customer: Dashboard → Transactions → Settings → back → back returns correctly, URL bar updates
- [ ] Rep: Dashboard → Search → Requests → Profile, same back/forward check
- [ ] Admin: Overview ↔ Disbursements (hash tabs), Customers ↔ Search, etc.
- [ ] Direct URL to `customer/dashboard.html` while logged out → redirected to `login.html`
- [ ] Logged-in customer manually visits `representative/dashboard.html` → redirected to their own dashboard
- [ ] Logged-in customer/rep visits `/admin/dashboard.html` → redirected to `/admin/login.html`

### Customer flows

- [ ] Create plan, see it in plan tabs, calendar renders
- [ ] Withdraw request (payment PIN required) → “Awaiting Admin Review” until admin marks reviewed
- [ ] Close plan only allowed at ₦0 balance; reactivate/delete closed plan
- [ ] Transactions page filters by type across all plans
- [ ] Settings: theme switch persists across pages/reload; password & PIN change work

### Representative flows

- [ ] Search customer by phone, select plan, collect deposit (multiple of regular contribution), receipt shown
- [ ] Pending withdrawal shows correct stage bar; approve/reject only after “reviewed”
- [ ] Requests page lists all reviewed withdrawals platform-wide; approve pays out, updates balance
- [ ] Collections page shows full deposit history with filters

### Admin flows

- [ ] Admin login lockout after 5 wrong PINs (30s)
- [ ] Overview cards populate; “Mark Reviewed” → now actionable by reps
- [ ] Customers: suspend → signed out within 30s (suspension poll); restore; delete blocked if balance > 0
- [ ] Field Agents: suspend/restore/delete; reliability % shown
- [ ] Generate activation token → usable in `register.html` rep signup
- [ ] Analytics cards/bar chart/top agents populate; “Remove Inactive Users” works
- [ ] Fraud Flags list + resolve
- [ ] Audit Log search/filter shows entries from all roles
- [ ] Settings: theme persists, PIN change validation, security log shows session attempts

### Security / Isolation

- [ ] `view-source` on any admin page confirms `js/auth.js` is NOT loaded
- [ ] `view-source` on any customer/rep page confirms no admin functions (`doAdminLogin`, `ADMIN_PIN`) are present
- [ ] sessionStorage keys `wagUser` and `wagAdmin` are independent — clearing one doesn’t affect the other