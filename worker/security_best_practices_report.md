# Security Best Practices Report

## Executive Summary

Scope reviewed: Cloudflare Workers + Hono + TypeScript application under `worker/src`, with focus on authentication, authorization, state-changing routes, and browser rendering paths.

Current status after remediation work on 2026-03-30:

1. Remediated: `viewer` accounts can no longer perform order-changing actions; mutation routes now require editor/admin privileges.
2. High: editor-controlled completion messages are stored and later rendered with `dangerouslySetInnerHTML` on customer pages, while CSP still allows inline script execution.
3. Medium: login throttling is implemented with isolate-local memory only, which the code itself notes is not production-grade for Cloudflare Workers.
4. Medium: privileged staff accounts can be created with weak passwords, and the built-in password generator only produces lowercase alphanumeric strings.

No unauthenticated critical remote compromise was evident from app code alone, but the remaining High finding still materially weakens customer-page safety.

## Remediated

### FJ-SEC-001

- Severity: High
- Rule ID: AUTHZ-001
- Status: Remediated on 2026-03-30
- Location:
  - `src/routes/staffApi.ts:17-23`
  - `src/routes/staffApi.ts:52-55`
  - `src/routes/staffApi.ts:126-230`
  - `src/routes/staffOrders.tsx:323-479`
- Evidence:

```ts
// src/routes/staffApi.ts
staffApi.use("/*", staffAuth);

function canEditOrders(role: string): boolean {
  return role === "admin" || role === "editor";
}

function denyEditorOnlyJson(c: Context<AppType>) {
  return c.json({ error: "Insufficient permissions" }, 403);
}

staffApi.post("/staff/api/orders/:id/inline-update", async (c) => {
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  ...
}
```

```ts
// src/routes/staffOrders.tsx
staffOrders.use("/*", staffAuth);

staffOrders.post("/staff/orders/:id/mark-paid", editorAuth, async (c) => { ... })
staffOrders.post("/staff/orders/:id/update", editorAuth, async (c) => { ... })
staffOrders.post("/staff/orders/:id/mark-picked-up", editorAuth, async (c) => { ... })
staffOrders.post("/staff/orders/:id/undo-picked-up", editorAuth, async (c) => { ... })
staffOrders.post("/staff/orders/:id/create-extension", editorAuth, async (c) => { ... })
staffOrders.post("/staff/orders/manual", editorAuth, async (c) => { ... })
```

- Impact: Previously, any authenticated `viewer` account could change order data, cancel orders, mark luggage picked up, alter pricing, or create new orders, which defeated the apparent read-only role boundary.
- Fix applied: Introduced an explicit editor/admin guard for JSON mutation routes and required `editorAuth` on HTML form mutation routes. Read-only routes remain on `staffAuth`.
- Follow-up: Add automated authorization tests so future mutation routes fail closed for `viewer`.
- False positive notes: This finding originally assumed `viewer` was intended to be read-only. That assumption remains supported by the UI role model and existing bulk-action restriction.

## High Severity

### FJ-SEC-002

- Severity: High
- Rule ID: JS-XSS-001
- Location:
  - `src/routes/admin.tsx:15`
  - `src/routes/admin.tsx:1139-1165`
  - `src/routes/customer.tsx:1785-1820`
  - `src/middleware/security.ts:17-18`
- Evidence:

```ts
// src/routes/admin.tsx
admin.use("/staff/admin/completion-message*", editorAuth);

const koPrimary = String(body.primary_message_ko || "");
const koSecondary = String(body.secondary_message_ko || "");
...
ON CONFLICT(setting_key) DO UPDATE SET setting_value = ?, staff_id = ?, updated_at = datetime('now')
```

```tsx
// src/routes/customer.tsx
<div class="completion-msg" dangerouslySetInnerHTML={{__html: primaryMsg ... }} />
<p ... dangerouslySetInnerHTML={{__html: title }} />
<p ... dangerouslySetInnerHTML={{__html: body ... }} />
```

```ts
// src/middleware/security.ts
"default-src 'self'; script-src 'self' 'unsafe-inline' ..."
```

- Impact: Any editor who can change completion messages can persist arbitrary HTML into customer-facing pages; because inline scripts/event handlers are allowed by CSP, this can become stored XSS against customers opening order-completion pages.
- Fix: Treat completion messages as plain text, not HTML. Render them with escaped text plus safe formatting transforms, or sanitize with a strict allowlist before storing/rendering. Then remove `unsafe-inline` from `script-src` if feasible.
- Mitigation: Restrict completion-message editing to admins until sanitization is in place, and add CSP reporting/monitoring for inline execution attempts.
- False positive notes: If HTML is intentionally supported, sanitization is still required. The current code shows no sanitization path before these strings reach `dangerouslySetInnerHTML`.

## Medium Severity

### FJ-SEC-003

- Severity: Medium
- Rule ID: AUTH-THROTTLE-001
- Location:
  - `src/index.tsx:28-30`
  - `src/middleware/security.ts:47-52`
- Evidence:

```ts
// src/index.tsx
app.use("/staff/login", createRateLimiter(10, 60_000));
```

```ts
// src/middleware/security.ts
/**
 * NOTE: resets per Worker isolate — use Cloudflare's rate limiting for
 * production-grade enforcement across all instances.
 */
const store = new Map<string, RateLimitEntry>();
```

- Impact: The only visible login throttle is per-isolate in-memory state, so attackers can bypass it by hitting different Workers instances or after isolate resets.
- Fix: Move login and customer-submit throttling to Cloudflare-native shared enforcement (WAF/rate limiting rules, Turnstile, or a shared durable store).
- Mitigation: Add alerting on repeated failed logins and temporarily raise authentication friction for repeated attempts.
- False positive notes: If Cloudflare edge rate limiting already exists outside this repo, verify that it covers `/staff/login` and `/customer/submit` before downgrading this finding.

### FJ-SEC-004

- Severity: Medium
- Rule ID: AUTH-PASSWORD-001
- Location:
  - `src/routes/admin.tsx:809-813`
  - `src/routes/admin.tsx:837-846`
- Evidence:

```ts
// src/routes/admin.tsx
var ch='abcdefghijklmnopqrstuvwxyz0123456789',pw='';
for(var i=0;i<10;i++){pw+=ch[Math.floor(Math.random()*ch.length)];}
```

```ts
if (password.length < 6) {
  return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("비밀번호는 6자리 이상 입력해주세요."));
}

const { data, error } = await supabaseAdmin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
```

- Impact: Staff accounts, including admins and editors, can be provisioned with short or low-complexity passwords, which increases the chance of credential compromise.
- Fix: Enforce a stronger minimum (for example 12+ chars) and require either passphrases or mixed character classes; update the generator to produce high-entropy random passwords from a broader alphabet.
- Mitigation: Pair the stronger password policy with MFA for staff accounts if your Supabase plan and staff workflow support it.
- False positive notes: If the organization already mandates SSO-only or MFA-only staff access, the exploitability is reduced, but the local account-creation path still permits weak credentials.

## Low Severity

No additional low-severity findings were documented in this pass.

## Suggested Remediation Order

1. Fix `viewer` authorization on all mutation routes.
2. Remove or sanitize HTML-capable completion messages before they reach customer pages.
3. Replace isolate-local throttling with shared edge enforcement.
4. Strengthen staff password policy and password generation defaults.
