# Production dependency security verification — 2026-11-21

Separate security branch based on the existing center-permission PR. No role, ledger, production flag, login setting, migration or customer row was changed. No merge or deployment was performed.

## Before / after

Production audit: 2 high / 24 moderate / 2 low advisory records → **all levels 0**. Only Hono 4.12.18 → 4.13.16 and a pinned ws 8.21.0 override were required. Sentry/Supabase/runtime config and Worker compatibility date were preserved. Earlier Hono fixes (4.12.25) do not cover the later advisories; 4.13.16 is the lowest common fixed 4.x release in the audited inventory.

## Production reachability

- W1: Hono is directly used by the F1 router, request/response and JSX output, so core query/body/response handling is potentially reachable. Individual exploitability depends on the helper and attacker-controlled inputs; no blanket unreachable claim is made.
- W2: The app does not import Hono CORS/validator/cache/compress/timeout/serve-static/Bun helpers. Helper-specific advisories have no observed direct application call site in this F1 source. Existing security middleware implements its own headers and auth.
- W3: ws is a transitive Supabase realtime dependency. No app channel/subscribe/WebSocket connect call site was found; no operational socket exploitability was demonstrated. It is still patched to remove the installed vulnerable implementation.

## Verification

- Fresh pnpm 10.29.3 install --frozen-lockfile, production audit all-zero, typecheck and all 430 tests passed, zero skipped.
- Wrangler F1 production dry-run bundle passed (2,295.66 KiB / gzip 460.92 KiB), no upload. Exact existing compatibility date 2025-04-01 and nodejs_compat are retained.
- The actual compiled F1 bundle starts in local workerd/Miniflare with synthetic local D1/R2 and external requests explicitly forbidden. Login rendering, escaped query error HTML, and unauthenticated staff redirect passed. No production bindings or customer data were accessed.
- Positive shared-budget authority remains an explicit test boundary in the inherited Center legacy confirmation suite; neither these checks nor the unchanged permission tests establish complete production PT/session or shared-budget E2E readiness.

## Complete advisory inventory

Each row links the primary GitHub advisory and lists all officially published fixed branches for that package. The installed selected versions are above; all production-audit rows are resolved.

| Advisory / package | Severity | Official fixed branches | Reachability | Installed path |
|---|---|---|---|
| [GHSA-2gcr-mfcq-wcc3](https://github.com/advisories/GHSA-2gcr-mfcq-wcc3) — hono — Hono: app.mount() strips mount prefix using undecoded path, causing incorrect routing for percent-encoded paths | moderate | 4.12.21 | W1 | .>hono |
| [GHSA-3gg2-335m-rxc6](https://github.com/advisories/GHSA-3gg2-335m-rxc6) — hono — Hono: `css` helper does not escape a closing tag split between the template and an interpolated value, allowing HTML injection | low | 4.13.16 | W1 | .>hono |
| [GHSA-3hrh-pfw6-9m5x](https://github.com/advisories/GHSA-3hrh-pfw6-9m5x) — hono — Hono: Cookie helper does not sanitize sameSite and priority, allowing Set-Cookie injection | moderate | 4.12.21 | W1 | .>hono |
| [GHSA-46wx-v44x-9hh2](https://github.com/advisories/GHSA-46wx-v44x-9hh2) — hono — Hono: `csrf()` does not check requests sent by hyperlink auditing (`text/ping`) | moderate | 4.13.16 | W2 | .>hono |
| [GHSA-4h7h-rv7c-7m2v](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v) — hono — Hono: `validator('form')` skips validation for `multipart/form-data` requests with extra parameters | moderate | 4.13.16 | W2 | .>hono |
| [GHSA-4m76-xfj5-7975](https://github.com/advisories/GHSA-4m76-xfj5-7975) — hono — Hono: `mount()` and `app.mount()` can forward a path that bypasses middleware scoped inside the mount prefix | moderate | 4.13.16 | W1 | .>hono |
| [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4) — hono — Hono: Algorithmic Complexity DoS in Language Middleware | moderate | 4.12.34 | W1 | .>hono |
| [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) — hono — Hono: `serveStatic` decodes the request path a second time, leading to bypass of middleware on static paths | moderate | 4.13.11 | W1 | .>hono |
| [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9) — hono — Hono: Proxy Helper does not remove response headers listed in the `Connection` header | low | 4.12.34 | W1 | .>hono |
| [GHSA-88fw-hqm2-52qc](https://github.com/advisories/GHSA-88fw-hqm2-52qc) — hono — hono: CORS Middleware reflects any Origin with credentials when `origin` defaults to the wildcard | high | 4.12.25 | W2 | .>hono |
| [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239) — hono — Hono: ReDoS in CORS middleware via Access-Control-Request-Headers | moderate | 4.12.34 | W2 | .>hono |
| [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx) — hono — Hono: Query parser reads parameters after the URL fragment, causing cache-key and proxy interpretation differentials | moderate | 4.13.5 | W1 | .>hono |
| [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r) — hono — Hono: `memo()` retains SSR output across requests, leading to cross-user data disclosure | moderate | 4.12.34 | W1 | .>hono |
| [GHSA-f577-qrjj-4474](https://github.com/advisories/GHSA-f577-qrjj-4474) — hono — Hono: JWT middleware accepts any Authorization scheme, not only Bearer | moderate | 4.12.21 | W2 | .>hono |
| [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc) — hono — Hono: Unbounded dot-notation nesting in `parseBody()` can cause memory exhaustion | moderate | 4.13.5 | W1 | .>hono |
| [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv) — hono — Hono: Incomplete fix for CVE-2026-39408: `toSSG()` still writes files outside the output directory | moderate | 4.13.5 | W1 | .>hono |
| [GHSA-h7mg-cq63-vhpq](https://github.com/advisories/GHSA-h7mg-cq63-vhpq) — hono — Hono: RegExpRouter skips wildcard middleware for some route sets and for paths with an encoded line terminator | moderate | 4.13.16 | W1 | .>hono |
| [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) — hono — hono/jsx does not isolate context per request, leading to cross-request data disclosure | moderate | 4.12.27 | W1 | .>hono |
| [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) — hono — hono/jsx renders plain strings unescaped in boundary components, leading to XSS | moderate | 4.13.7 | W1 | .>hono |
| [GHSA-j6c9-x7qj-28xf](https://github.com/advisories/GHSA-j6c9-x7qj-28xf) — hono — hono: AWS Lambda adapter merges multiple `Set-Cookie` headers into one value, dropping cookies on ALB single-header and Lattice | moderate | 4.12.25 | W1 | .>hono |
| [GHSA-rv63-4mwf-qqc2](https://github.com/advisories/GHSA-rv63-4mwf-qqc2) — hono — hono: Body Limit Middleware can be bypassed on AWS Lambda by understating `Content-Length` | moderate | 4.12.25 | W1 | .>hono |
| [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59) — hono — Hono: Server-Side XSS via JSX Escaping Bypass in cx() Utility | moderate | 4.12.27 | W1 | .>hono |
| [GHSA-wgpf-jwqj-8h8p](https://github.com/advisories/GHSA-wgpf-jwqj-8h8p) — hono — hono: Lambda@Edge adapter keeps only the last value of a repeated request header, dropping the rest | moderate | 4.12.25 | W1 | .>hono |
| [GHSA-wwfh-h76j-fc44](https://github.com/advisories/GHSA-wwfh-h76j-fc44) — hono — hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`) | moderate | 4.12.25 | W2 | .>hono |
| [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) — hono — Hono: API Gateway v1 adapter can drop a distinct repeated request header value during de-duplication | moderate | 4.12.27 | W1 | .>hono |
| [GHSA-xrhx-7g5j-rcj5](https://github.com/advisories/GHSA-xrhx-7g5j-rcj5) — hono — Hono: IP Restriction bypasses static deny rules for non-canonical IPv6  | moderate | 4.12.21 | W1 | .>hono |
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — ws — ws: Uninitialized memory disclosure | moderate | 8.20.1 | W3 | .>@supabase/supabase-js>@supabase/realtime-js>ws |
| [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — ws — ws: Memory exhaustion DoS from tiny fragments and data chunks | high | 5.2.5; 6.2.4; 7.5.11; 8.21.0 | W3 | .>@supabase/supabase-js>@supabase/realtime-js>ws |

Evidence: /private/tmp/phase3-luggage-audit-final.json (Luggage final audit is phase3-luggage-audit-after1.json), phase3-luggage-clean-install.log, phase3-luggage-typecheck.log, phase3-luggage-tests.log, phase3-luggage-build.log. Official full advisory records: /private/tmp/phase3-center-luggage-advisories/*.json.
