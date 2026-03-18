import { Hono } from "hono";
import type { AppType } from "../types";

const staticRoutes = new Hono<AppType>();

// Serve a simple SVG favicon (no external files needed in Workers)
staticRoutes.get("/favicon.ico", (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">🧳</text></svg>`;
  return c.body(svg, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
});

// Serve logo from R2
staticRoutes.get("/static/logo-horizontal.png", async (c) => {
  const obj = await c.env.IMAGES.get("static/logo-horizontal.png");
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// Embedded CSS — ported from original FastAPI app.css
const CSS_CONTENT = `
/* ============================================================
   Flying Japan Luggage Storage — Staff Site Stylesheet
   Ported from original FastAPI app.css
   ============================================================ */

:root {
  --bg: #eef3fb;
  --bg-deep: #e7f0ff;
  --surface: #ffffff;
  --surface-soft: #f5f9ff;
  --line: #dbe4f2;
  --line-strong: #cedaee;
  --text: #191f28;
  --subtext: #4a5668;
  --muted: #7d8794;
  --primary: #2f80f8;
  --primary-strong: #1e63da;
  --primary-soft: #eaf2ff;
  --positive: #12b886;
  --warning: #ef7d22;
  --radius-xl: 26px;
  --radius-lg: 20px;
  --radius-md: 12px;
  --shadow-sm: 0 10px 30px rgba(16, 31, 60, 0.07);
  --shadow-md: 0 14px 36px rgba(16, 31, 60, 0.11);
  --shadow-lg: 0 22px 52px rgba(39, 103, 209, 0.2);
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; width: 100%; }

body {
  position: relative;
  font-family: "Pretendard", "Noto Sans KR", "Noto Sans JP", system-ui, -apple-system, sans-serif;
  color: var(--text);
  background:
    radial-gradient(1200px 560px at -10% -8%, rgba(141, 190, 255, 0.42) 0%, rgba(141, 190, 255, 0) 68%),
    radial-gradient(980px 520px at 106% -14%, rgba(138, 220, 255, 0.34) 0%, rgba(138, 220, 255, 0) 70%),
    linear-gradient(180deg, #f2f6ff 0%, #edf3fc 100%);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  background-image:
    radial-gradient(circle at 1px 1px, rgba(87, 111, 150, 0.08) 1px, transparent 0);
  background-size: 28px 28px;
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.22), transparent 68%);
}

a { color: inherit; text-decoration: none; }

/* ── Background orbs ── */
.bg-orb {
  position: fixed;
  z-index: -1;
  width: 560px;
  height: 560px;
  border-radius: 50%;
  filter: blur(72px);
  opacity: 0.48;
  pointer-events: none;
}
.bg-orb-left { left: -200px; top: -190px; background: #95bdff; }
.bg-orb-right { right: -220px; top: -70px; background: #8fdfff; }

/* ── Topbar ── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(136, 158, 195, 0.22);
  background: linear-gradient(180deg, rgba(246, 250, 255, 0.93) 0%, rgba(241, 247, 255, 0.84) 100%);
  box-shadow: 0 8px 24px rgba(17, 34, 68, 0.08);
}

.topbar-inner {
  width: 100%;
  max-width: 1120px;
  margin-inline: auto;
  padding: 13px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.brand-logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
  mix-blend-mode: multiply;
}

/* ── Pill nav ── */
.pill-nav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(231, 240, 252, 0.88);
  padding: 5px;
  border-radius: 999px;
  border: 1px solid #d4dfef;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
}

.pill-link {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #4a5c78;
  border-radius: 999px;
  letter-spacing: -0.01em;
  transition: background 0.15s, color 0.15s;
}

.pill-link:hover {
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
}

.pill-link-strong {
  background: var(--primary);
  color: #fff;
  font-weight: 700;
}

.pill-link-strong:hover {
  background: #2563eb;
  color: #fff;
}

.pill-user {
  padding: 0 8px 0 4px;
  font-size: 12px;
  font-weight: 500;
  color: #6b7a90;
  border-left: 1px solid #c8d5e6;
  margin-left: 2px;
  line-height: 1;
}

/* ── Container ── */
.container {
  width: 100%;
  max-width: 1080px;
  margin: 24px auto 44px;
  padding: 0 16px;
  display: grid;
  gap: 18px;
}

/* ── Hero ── */
.hero {
  padding: 4px 2px;
  animation: riseIn 0.45s ease both;
}

.hero-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}

.hero-kicker {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero-title {
  margin: 6px 0 0;
  font-size: clamp(26px, 5vw, 34px);
  font-weight: 800;
  letter-spacing: -0.03em;
}

.hero-desc {
  margin: 10px 0 0;
  color: var(--subtext);
  font-size: 15px;
}

/* ── Card ── */
.card {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(252, 254, 255, 0.98) 100%);
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.78);
  padding: 22px;
  animation: riseIn 0.42s ease both;
}

.card-primary {
  border-color: #cddffb;
  box-shadow: var(--shadow-lg);
}

.card-title {
  margin: 0;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.card-desc {
  margin: 8px 0 0;
  color: var(--subtext);
  font-size: 14px;
}

/* ── Forms ── */
form { margin-top: 16px; }

.field {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
}

.field-label {
  font-size: 13px;
  color: var(--subtext);
  font-weight: 600;
}

.field-hint {
  color: #3f5e88;
  font-size: 12px;
}

.control {
  width: 100%;
  min-height: 44px;
  border: 1px solid #cfdcf0;
  background: linear-gradient(180deg, #ffffff 0%, #fdfefe 100%);
  color: var(--text);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  font-size: 15px;
  font-family: inherit;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.control:focus {
  outline: none;
  border-color: #87b1f6;
  background: #fff;
  box-shadow: 0 0 0 4px rgba(46, 123, 244, 0.14);
}

input[type="checkbox"],
input[type="radio"] {
  width: auto;
  margin-right: 6px;
  accent-color: var(--primary);
}

textarea { min-height: 90px; resize: vertical; }

select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23475569' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
  -webkit-appearance: none;
  appearance: none;
}

.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.grid3 {
  display: grid;
  grid-template-columns: 1fr 2fr auto;
  gap: 12px;
  align-items: end;
}

.button-wrap {
  display: flex;
  align-items: end;
  margin-bottom: 14px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 16px;
  color: var(--subtext);
  font-size: 13px;
}

.check-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: var(--primary);
}

/* ── Buttons ── */
.btn,
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 14px;
  min-height: 42px;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  letter-spacing: -0.01em;
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease, border-color 0.16s ease;
}

.btn-primary,
button {
  background: linear-gradient(160deg, var(--primary) 0%, var(--primary-strong) 100%);
  color: #fff;
  border-color: rgba(15, 73, 166, 0.18);
  box-shadow: 0 10px 24px rgba(47, 128, 248, 0.26);
}

.btn-secondary {
  background: linear-gradient(180deg, #f7faff 0%, #eff5ff 100%);
  color: #23446b;
  border: 1px solid #d1ddf0;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.84);
}

.btn-google {
  background: #fff;
  color: #3c4043;
  border: 1.5px solid #dadce0;
  gap: 10px;
  font-weight: 600;
  justify-content: center;
}
.btn-google:hover { background: #f8f9fa; border-color: #bdc1c6; }

.login-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #999;
  font-size: 13px;
  margin: 4px 0;
}
.login-divider::before,
.login-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e2e8f0;
}

.btn-lg {
  width: 100%;
  padding: 14px 18px;
  font-size: 15px;
}

.btn-sm {
  width: auto;
  padding: 7px 10px;
  min-height: 32px;
  border-radius: 11px;
  font-size: 12px;
  box-shadow: none;
}

td .btn-sm + .btn-sm { margin-left: 6px; }

.btn:hover, button:hover { transform: translateY(-1px); filter: saturate(1.04); }
.btn:active, button:active { transform: translateY(0); }

.btn-link {
  display: inline-block;
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 999px;
  background: #ebf2ff;
  color: #245ca9;
  font-size: 13px;
  font-weight: 700;
}

/* ── Tables ── */
.table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin-top: 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.9);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
}

th, td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid #e7edf7;
  font-size: 13px;
  white-space: nowrap;
  vertical-align: middle;
}

th {
  color: var(--muted);
  font-weight: 700;
  background: linear-gradient(180deg, #f8fbff 0%, #f3f7ff 100%);
}

tbody tr:nth-child(even) { background: rgba(245, 250, 255, 0.48); }
tbody tr:hover { background: #eef5ff; }

.table-control {
  min-width: 98px;
  max-width: 180px;
  padding: 8px 10px;
  font-size: 12px;
}

.table-link {
  color: #1b64da;
  font-weight: 700;
}

/* ── Staff orders table ── */
#staff-orders-table { table-layout: fixed; min-width: 100%; }
#staff-orders-table col[data-col-key="name"] { width: 8%; }
#staff-orders-table col[data-col-key="tag_no"] { width: 5%; }
#staff-orders-table col[data-col-key="created_time"] { width: 8%; }
#staff-orders-table col[data-col-key="price"] { width: 7%; }
#staff-orders-table col[data-col-key="pickup_time"] { width: 7%; }
#staff-orders-table col[data-col-key="pay_status"] { width: 6%; }
#staff-orders-table col[data-col-key="pickup_status"] { width: 6%; }
#staff-orders-table col[data-col-key="actions"] { width: 18%; }
#staff-orders-table col[data-col-key="note"] { width: 32%; }
#staff-orders-table col[data-col-key="detail"] { width: 3%; }

#staff-orders-table th, #staff-orders-table td {
  padding: 6px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
  border-bottom: 1px solid #e2e9f3;
}

#staff-orders-table th {
  position: relative;
  padding-right: 14px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #5a6f8a;
  font-weight: 700;
  background: #f5f8fc;
  border-bottom: 2px solid #d0daea;
}

#staff-orders-table .table-control {
  min-width: 0;
  max-width: none;
  width: 100%;
  padding: 4px 6px;
  font-size: 13px;
  min-height: 0;
  height: 28px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  box-shadow: none;
  transition: border-color 0.15s, background 0.15s;
}

#staff-orders-table .table-control:hover { border-color: #d0daea; }
#staff-orders-table .table-control:focus {
  border-color: #4a90d9;
  background: #fff;
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.12);
}

#staff-orders-table .btn-sm {
  padding: 0 7px;
  min-height: 0;
  height: 22px;
  font-size: 10px;
  border-radius: 4px;
  line-height: 22px;
  white-space: nowrap;
  flex-shrink: 0;
}

#staff-orders-table tbody tr:nth-child(even) { background: #f8fafc; }
#staff-orders-table tbody tr:hover { background: #f0f6ff; box-shadow: inset 3px 0 0 var(--primary); }

#staff-orders-table .btn:hover, #staff-orders-table button:hover { transform: none; }

.inline-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.inline-actions form { margin: 0; }

#staff-orders-table .inline-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 3px;
}

/* ── Payment state button ── */
.payment-state-btn {
  justify-content: center;
  border-radius: 4px;
  border: 1px solid transparent;
  box-shadow: none;
}

.payment-state-btn.is-paid {
  background: #f0faf4;
  color: #166534;
  border-color: #bbf7d0;
  font-weight: 600;
}

.payment-state-btn.is-pending {
  background: #fffbeb;
  color: #b45309;
  border-color: #fcd34d;
  font-weight: 700;
}

/* ── Pickup buttons ── */
.pickup-complete-btn {
  background: var(--primary, #2f80f8);
  color: #fff;
  border: 1px solid var(--primary, #2f80f8);
  font-weight: 600;
}

.pickup-undo-btn {
  background: transparent;
  color: #64748b;
  border: 1px solid #cbd5e1;
  font-weight: 500;
}

/* ── Warehouse ── */
.warehouse-btn {
  font-size: 10px;
  padding: 0 6px;
  height: 22px;
  line-height: 22px;
  border-radius: 4px;
  border: 1px solid #cbd5e1;
  background: transparent;
  color: #64748b;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.warehouse-btn.is-active {
  background: #334155;
  color: #fff;
  border-color: #334155;
}

/* ── Warehouse row ── */
#staff-orders-table tbody tr.is-in-warehouse {
  background: #f1f5f9;
  border-left: 3px solid #475569;
}

/* ── Extension row ── */
#staff-orders-table tbody tr.is-extension {
  border-left: 3px solid #a78bfa;
  background: rgba(167, 139, 250, 0.05);
}

.extension-badge {
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px 5px;
  border-radius: 4px;
  background: #9f7aea;
  color: #fff;
  font-size: 8px;
  font-weight: 700;
  vertical-align: middle;
}

.name-cell-wrap {
  display: flex;
  align-items: center;
  gap: 3px;
}
.name-cell-wrap .table-control { flex: 1; min-width: 0; }

/* ── Cancelled row ── */
#staff-orders-table tbody tr.is-cancelled {
  opacity: 0.45;
  text-decoration: line-through;
}

.cancel-btn {
  font-size: 11px;
  padding: 0 6px;
  height: 22px;
  line-height: 22px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: #94a3b8;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s;
}

#staff-orders-table tbody tr:hover .cancel-btn { opacity: 1; color: #dc2626; }
.cancel-btn:hover { background: #fef2f2; border-color: #fca5a5; color: #dc2626; opacity: 1; }

/* ── Bulk action bar ── */
.bulk-action-bar {
  display: none;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 12px 16px;
  border-radius: 14px;
  background: linear-gradient(160deg, #1e3a5f 0%, #1a2d4d 100%);
  color: #fff;
  box-shadow: 0 8px 24px rgba(26, 45, 77, 0.3);
  animation: riseIn 0.25s ease both;
}

.bulk-action-bar.is-visible { display: flex; }

.bulk-action-label { font-size: 13px; font-weight: 700; margin-right: 8px; }

.bulk-action-bar .btn-sm { font-size: 11px; padding: 6px 12px; border-radius: 8px; font-weight: 700; }
.bulk-action-bar .btn-primary { background: #38a169; border-color: #38a169; color: #fff; }
.bulk-action-bar .btn-secondary { background: rgba(255, 255, 255, 0.15); border-color: rgba(255, 255, 255, 0.3); color: #fff; }
.bulk-action-bar .cancel-btn { background: #e53e3e; border-color: #e53e3e; color: #fff; opacity: 1; }
.bulk-action-bar .warehouse-btn { background: #475569; border-color: #475569; color: #fff; }

/* ── Bulk checkbox ── */
#staff-orders-table [data-col-key="checkbox"] { text-align: center; width: 36px; }
.bulk-check { width: 16px; height: 16px; accent-color: #1e63da; cursor: pointer; }
#bulk-select-all { width: 16px; height: 16px; accent-color: #1e63da; cursor: pointer; }

/* ── Extra payment badge ── */
.extra-payment-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 5px;
  height: 18px;
  line-height: 18px;
  border-radius: 3px;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

/* ── Price ── */
.price-amount {
  font-size: 14px;
  font-weight: 800;
  color: #1d4f9e;
  line-height: 1.25;
}

.price-summary-row {
  display: inline-flex;
  max-width: 260px;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

/* ── Discount/manual section ── */
.discount-details {
  border: 1px solid #d4e1f5;
  border-radius: 16px;
  background: linear-gradient(180deg, #f8fbff 0%, #f1f7ff 100%);
  padding: 12px;
}

.discount-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  list-style: none;
  font-size: 14px;
  font-weight: 700;
  color: #24487a;
}

.discount-summary::-webkit-details-marker { display: none; }

.discount-summary::after {
  content: "+";
  display: inline-flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #dce9ff;
  color: #1f63d8;
  font-weight: 800;
}

.discount-details[open] .discount-summary::after { content: "-"; }

/* ── Search form ── */
.staff-search-form {
  display: grid;
  gap: 12px;
  background: #e2ecf9;
  border: 1px solid #b8cceb;
  border-radius: 16px;
  padding: 16px;
}

.staff-search-form .field-label {
  color: #1a2d4d;
  font-weight: 700;
  font-size: 13px;
}

.staff-search-form .control {
  border: 2px solid #8ba8d4;
  background: #ffffff;
  font-weight: 600;
  color: #1a2d4d;
}

.staff-search-form .control::placeholder { color: #5a7399; font-weight: 600; }
.staff-search-form .control:focus { border-color: #2f6fd0; box-shadow: 0 0 0 4px rgba(47, 111, 208, 0.2); }

.staff-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.staff-search-button-wrap { margin-bottom: 14px; }

/* ── Status filter ── */
.status-filter-buttons { display: flex; flex-wrap: wrap; gap: 8px; }

.status-filter-chip { position: relative; display: inline-flex; cursor: pointer; }
.status-filter-input { position: absolute; opacity: 0; pointer-events: none; }

.status-filter-chip span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 88px;
  padding: 9px 12px;
  border-radius: 999px;
  border: 1px solid #ccdbee;
  background: #edf3ff;
  color: #315172;
  font-size: 12px;
  font-weight: 700;
}

.status-filter-chip input:checked + span {
  border-color: #286fe4;
  background: linear-gradient(160deg, #3b8bf8 0%, #1f66dd 100%);
  color: #fff;
  box-shadow: 0 8px 18px rgba(31, 102, 221, 0.24);
}

.status-filter-all {
  border: 1px solid #ccdbee;
  background: #edf3ff;
  color: #315172;
  box-shadow: none;
  border-radius: 999px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 700;
}

.status-filter-all.is-active {
  border-color: #286fe4;
  background: linear-gradient(160deg, #3b8bf8 0%, #1f66dd 100%);
  color: #fff;
  box-shadow: 0 8px 18px rgba(31, 102, 221, 0.24);
}

/* ── Status pills ── */
.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
}

.status-payment_pending { color: #8a4a15; background: #fff3e5; }
.status-paid { color: #0f766e; background: #e6fcf5; }
.status-picked_up { color: #1e3a8a; background: #e8efff; }
.status-cancelled { color: #991b1b; background: #fef2f2; }

/* ── Tag number cell colors (pill style on tag_no cell) ── */
.tag-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; padding: 3px 10px; border-radius: 999px; font-weight: 800; font-size: 13px; }
.tag-color-orange { color: #c2410c; background: #fff7ed; border: 1.5px solid #fb923c; }
.tag-color-blue { color: #1e40af; background: #eff6ff; border: 1.5px solid #60a5fa; }
.tag-color-yellow { color: #92400e; background: #fefce8; border: 1.5px solid #facc15; }
.tag-color-green { color: #166534; background: #f0fdf4; border: 1.5px solid #4ade80; }
.tag-color-purple { color: #6b21a8; background: #faf5ff; border: 1.5px solid #a78bfa; }
.tag-color-black { color: #1a202c; background: #f1f5f9; border: 1.5px solid #64748b; }
.tag-color-gray { color: #475569; background: #f8fafc; border: 1.5px solid #94a3b8; }
.tag-color-pink { color: #9d174d; background: #fdf2f8; border: 1.5px solid #f472b6; }
.tag-color-brown { color: #78350f; background: #fffbeb; border: 1.5px solid #d97706; }

/* ── Click-to-edit cells ── */
.editable { cursor: pointer; border-bottom: 1px dashed transparent; transition: border-color 0.15s; }
.editable:hover { border-bottom-color: #cbd5e1; }
.editable.editing { background: #f8faff; border-bottom: 2px solid var(--primary, #2383e2); outline: none; padding: 2px 4px; min-width: 30px; }
.edit-input { font: inherit; color: inherit; border: 1px solid var(--primary, #2383e2); border-radius: 4px; padding: 3px 6px; background: #fff; outline: none; width: 100%; }

/* ── Inline action buttons ── */
.inline-actions { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.inline-actions button { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid #ddd; cursor: pointer; white-space: nowrap; font-weight: 600; }

.payment-state-btn.is-paid { background: #f0faf4; color: #166534; border-color: #86efac; }
.payment-state-btn.is-pending { background: #fffbeb; color: #b45309; border-color: #fcd34d; }
.payment-state-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.pickup-complete-btn { background: #eff6ff; color: #1d4ed8; border-color: #93c5fd !important; }
.pickup-undo-btn { background: #f5f5f4; color: #57534e; border-color: #d6d3d1 !important; }

.cancel-btn { background: #fef2f2; color: #991b1b; border-color: #fca5a5 !important; }

.warehouse-btn { background: #f8fafc; color: #64748b; border-color: #cbd5e1 !important; }
.warehouse-btn.is-active { background: #f0f9ff; color: #0369a1; border-color: #7dd3fc !important; font-weight: 700; }

/* ── Row states ── */
tr.is-cancelled td { opacity: 0.45; text-decoration: line-through; }
tr.is-in-warehouse { border-left: 3px solid #94a3b8; }

/* ── Extension badge ── */
.extension-badge { display: inline-block; background: #a78bfa; color: #fff; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }

/* ── Price popover ── */
.price-popover { position: absolute; z-index: 50; background: #fff; border: 1px solid #dbe4f2; border-radius: 8px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); display: flex; flex-direction: column; gap: 8px; min-width: 220px; font-size: 13px; }
.price-popover label { display: flex; flex-direction: column; gap: 2px; font-weight: 600; font-size: 12px; color: #787774; }
.price-popover select, .price-popover input[type="number"] { padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.price-popover .btn-row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }

/* ── Summary grid ── */
.summary-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
}

.summary-grid p {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface-soft);
  border: 1px solid #e8edf6;
  display: grid;
  gap: 4px;
}

.summary-grid strong { font-size: 12px; color: var(--muted); font-weight: 700; }
.summary-grid span { font-size: 14px; color: var(--text); }

/* ── Detail action grid ── */
.detail-action-grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.detail-action-box {
  border: 1px solid #e1e9f7;
  border-radius: 16px;
  background: #f9fbff;
  padding: 14px;
}

.detail-action-title { margin: 0; font-size: 16px; font-weight: 700; }
.detail-action-form { margin-top: 12px; }

/* ── Error & success ── */
.error {
  color: #c73535;
  background: #fff1f1;
  border: 1px solid #ffd7d7;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  margin: 0 0 12px;
}

.success-note {
  color: #166534;
  background: #ecfdf3;
  border: 1px solid #c9f0d8;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  margin: 0 0 12px;
}

.muted { color: var(--muted); font-size: 13px; }

code {
  padding: 2px 6px;
  border-radius: 6px;
  background: #f0f4fb;
  border: 1px solid #e0e7f5;
  color: #284672;
}

.admin-tools { margin-top: 14px; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.is-hidden { display: none !important; }

/* ── Staff menu ── */
.staff-menu {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 10px;
  border: 1px solid #d8e3f5;
  border-radius: 18px;
  background: linear-gradient(180deg, #f7faff 0%, #f2f7ff 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.staff-menu-link {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid #d0def3;
  background: #ffffff;
  color: #315070;
  font-size: 12px;
  font-weight: 700;
  padding: 8px 12px;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset;
}

.staff-menu-link.is-active {
  border-color: #2a71e6;
  background: linear-gradient(160deg, #3889f8 0%, #1f66dd 100%);
  color: #fff;
  box-shadow: 0 8px 18px rgba(31, 102, 221, 0.28);
}

/* ── Handover / Ops items ── */
.ops-board { margin-top: 12px; display: grid; gap: 10px; }

.ops-item {
  border: 1px solid #dfe8f8;
  border-radius: 14px;
  background: #f9fbff;
  padding: 12px;
}

.ops-item-unread { border-color: #ea5757; box-shadow: 0 0 0 1px rgba(234, 87, 87, 0.16); background: #fff9f9; }

.ops-item-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.ops-item-title { margin: 10px 0 6px; font-size: 15px; font-weight: 700; }
.ops-item-body { margin: 0; font-size: 14px; color: var(--text); white-space: pre-wrap; }

/* ── Cash closing ── */
.cash-entry-form { margin-top: 8px; display: grid; gap: 12px; }
.cash-compact-card { width: min(1240px, 100%); margin-inline: auto; }

.cash-denom-panel, .cash-summary-panel {
  border: 1px solid #dce5f6;
  border-radius: 14px;
  background: #f9fbff;
  padding: 12px;
}

.cash-section-label { margin: 0 0 8px; color: #3f5f89; }

.cash-denom-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(88px, 104px));
  justify-content: flex-start;
}

.cash-denom-item { margin: 0; display: grid; gap: 6px; justify-items: start; }
.cash-denom-item span { font-size: 12px; color: #53637a; font-weight: 700; }
.cash-denom-item .control { width: 88px; min-width: 88px; max-width: 88px; text-align: right; }

/* ── Account management ── */
.account-list { margin-top: 12px; display: grid; gap: 10px; }
.account-item { border: 1px solid #dfe8f8; border-radius: 14px; background: #fff; padding: 12px; }

.account-create-grid {
  margin-top: 12px;
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 320px));
  justify-content: flex-start;
  align-items: end;
}

/* ── QR ── */
.qr {
  width: 180px;
  height: 180px;
  margin: 14px auto 8px;
  border-radius: 18px;
  border: 1px solid #d8e3f8;
  background: #fff;
  padding: 8px;
}

/* ── Floating bug report button ── */
.fab-bug-report {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  box-shadow: 0 4px 14px rgba(47, 128, 248, 0.4);
  transition: background 0.15s, transform 0.15s;
  text-decoration: none;
}

.fab-bug-report:hover { background: var(--primary-strong); transform: scale(1.08); }
.fab-bug-report svg { display: block; }

/* ═══════════════════════════════════════════════════
   NOTION-STYLE STAFF SITE OVERRIDES
   ═══════════════════════════════════════════════════ */

body.staff-site {
  --text: #37352f;
  --subtext: #787774;
  --muted: #a5a5a3;
  --line: #e5e5e5;
  --line-strong: #d4d4d4;
  --primary: #2383e2;
  --primary-strong: #1b6ec2;
  --primary-soft: #e8f0fe;
  --surface: #ffffff;
  --surface-soft: #f7f7f5;
  --bg: #ffffff;
  --bg-deep: #ffffff;

  background: #ffffff;
  color: #37352f;
  font-size: 13px;
}

body.staff-site::before { display: none; }
body.staff-site .bg-orb { display: none; }

/* ── Staff Topbar ── */
body.staff-site .topbar {
  background: #ffffff;
  border-bottom: 1px solid #e5e5e5;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

body.staff-site .topbar-inner {
  padding: 8px 24px;
  max-width: 100%;
}

body.staff-site .brand { font-size: 14px; font-weight: 600; color: #37352f; letter-spacing: 0; }
body.staff-site .brand-logo { width: 24px; height: 24px; }

body.staff-site .pill-nav {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  gap: 2px;
}

body.staff-site .pill-link {
  color: #787774;
  font-size: 13px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 4px;
}

body.staff-site .pill-link:hover { background: #f7f7f5; color: #37352f; }
body.staff-site .pill-link-strong { background: #f0f0ef; color: #37352f; font-weight: 600; }
body.staff-site .pill-link-strong:hover { background: #e8e8e6; color: #37352f; }

body.staff-site .pill-user {
  color: #787774;
  font-size: 12px;
  border-left-color: #e5e5e5;
}

/* ── Staff Layout ── */
body.staff-site .container {
  width: 100%;
  max-width: 100%;
  gap: 0;
  margin: 0 auto;
  padding: 0 24px;
}

/* ── Staff Hero ── */
body.staff-site .hero { padding: 20px 24px 4px; animation: none; }
body.staff-site .hero-kicker { display: none; }
body.staff-site .hero-title { font-size: 20px; font-weight: 700; color: #37352f; letter-spacing: -0.01em; margin: 0; }
body.staff-site .hero-desc { font-size: 12px; color: #a5a5a3; margin: 2px 0 0; }

/* ── Staff Cards ── */
body.staff-site .card {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
  padding: 16px 0;
  animation: none;
}

body.staff-site .card:hover { border-color: transparent; box-shadow: none; }

body.staff-site .card-title {
  font-size: 11px;
  font-weight: 600;
  color: #a5a5a3;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

body.staff-site .card-desc { font-size: 12px; color: #a5a5a3; margin-top: 4px; }

/* ── Staff Search form ── */
body.staff-site .staff-search-form { background: transparent; border: none; border-radius: 0; padding: 0; }

body.staff-site .staff-search-form .field-label {
  color: #787774;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

body.staff-site .staff-search-form .control {
  border: 1px solid #e5e5e5;
  background: #ffffff;
  font-weight: 400;
  color: #37352f;
  border-radius: 4px;
  min-height: 32px;
  padding: 6px 10px;
  font-size: 13px;
  box-shadow: none;
}

body.staff-site .staff-search-form .control::placeholder { color: #c4c4c2; font-weight: 400; }
body.staff-site .staff-search-form .control:focus { border-color: #2383e2; box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.15); }

/* ── Staff Status filter chips ── */
body.staff-site .status-filter-buttons .status-filter-chip span {
  border: 1px solid #e5e5e5;
  background: #ffffff;
  color: #787774;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  min-height: 0;
  box-shadow: none;
}

body.staff-site .status-filter-buttons .status-filter-chip input:checked + span {
  border-color: #2383e2;
  background: #e8f0fe;
  color: #2383e2;
  box-shadow: none;
  font-weight: 600;
}

body.staff-site .status-filter-buttons .status-filter-all {
  display: inline-flex;
  align-items: center;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  color: #787774;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: none;
  min-height: 0;
}

body.staff-site .status-filter-buttons .status-filter-all.is-active {
  border-color: #2383e2;
  background: #e8f0fe;
  color: #2383e2;
  box-shadow: none;
}

body.staff-site .check-row { color: #787774; font-size: 12px; margin: 8px 0; }

/* ── Staff Buttons ── */
body.staff-site .btn,
body.staff-site button {
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  min-height: 32px;
  padding: 6px 12px;
  letter-spacing: 0;
  transition: background 0.1s;
}

body.staff-site .btn:hover, body.staff-site button:hover { transform: none; filter: none; }
body.staff-site .btn:active, body.staff-site button:active { transform: none; }

body.staff-site button {
  background: #ffffff;
  color: #37352f;
  border: 1px solid #e5e5e5;
  box-shadow: none;
}

body.staff-site button:hover { background: #f7f7f5; }

body.staff-site .btn-primary,
body.staff-site button[type="submit"] {
  background: #2383e2;
  color: #ffffff;
  border: none;
  box-shadow: none;
  font-weight: 500;
}

body.staff-site .btn-primary:hover,
body.staff-site button[type="submit"]:hover { background: #1b6ec2; color: #ffffff; }

body.staff-site .btn-secondary {
  background: #ffffff;
  color: #37352f;
  border: 1px solid #e5e5e5;
  box-shadow: none;
}

body.staff-site .btn-secondary:hover { background: #f7f7f5; }
body.staff-site .btn-sm { border-radius: 4px; }

/* ── Staff Table ── */
body.staff-site .table-wrap {
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  margin-top: 8px;
  border-top: 1px solid #e5e5e5;
  min-height: 420px;
}

body.staff-site table { background: #ffffff; }

body.staff-site th, body.staff-site td {
  border-bottom: 1px solid #efefed;
  font-size: 13px;
}

body.staff-site th {
  background: #ffffff;
  color: #a5a5a3;
  font-size: 11px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

body.staff-site tbody tr:nth-child(even) { background: transparent; }
body.staff-site tbody tr:hover { background: #f7f7f5; }

/* ── Staff orders table specifics ── */
body.staff-site #staff-orders-table th {
  background: #fbfbfa;
  border-bottom: 1px solid #e5e5e5;
  color: #787774;
  font-size: 11px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  padding: 4px 6px;
}

body.staff-site #staff-orders-table td {
  padding: 3px 6px;
  border-bottom: 1px solid #efefed;
  vertical-align: middle;
}

body.staff-site #staff-orders-table tbody tr:nth-child(even) { background: transparent; }
body.staff-site #staff-orders-table tbody tr:hover { background: #f7f7f5; box-shadow: none; }

body.staff-site #staff-orders-table .table-control {
  font-size: 13px;
  border-radius: 3px;
  border: 1px solid transparent;
  background: transparent;
  color: #37352f;
  height: 24px;
  min-height: 0;
  padding: 2px 4px;
  box-shadow: none;
}

body.staff-site #staff-orders-table .table-control:hover { background: #f7f7f5; border-color: #e5e5e5; }
body.staff-site #staff-orders-table .table-control:focus {
  background: #ffffff;
  border-color: #2383e2;
  box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.12);
}

body.staff-site #staff-orders-table .btn,
body.staff-site #staff-orders-table button {
  background: transparent;
  border: none;
  box-shadow: none;
  min-height: 0;
  border-radius: 3px;
  color: #787774;
  padding: 0 5px;
  height: 22px;
  line-height: 22px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

body.staff-site #staff-orders-table .btn:hover,
body.staff-site #staff-orders-table button:hover {
  background: #f0f0ef;
  color: #37352f;
  transform: none;
  filter: none;
}

body.staff-site #staff-orders-table .inline-actions { flex-wrap: nowrap; gap: 1px; }

/* ── Staff payment state ── */
body.staff-site .payment-state-btn {
  display: inline-flex;
  align-items: center;
  border: none;
  border-radius: 3px;
  font-size: 12px;
  gap: 5px;
  padding: 0 6px;
  background: transparent;
}

body.staff-site .payment-state-btn::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

body.staff-site .payment-state-btn.is-paid { background: transparent; border: none; color: #4dab9a; font-weight: 500; }
body.staff-site .payment-state-btn.is-paid:hover { background: #f0faf4; }
body.staff-site .payment-state-btn.is-paid::before { background: #4dab9a; }

body.staff-site .payment-state-btn.is-pending { background: transparent; border: none; color: #cb912f; font-weight: 600; }
body.staff-site .payment-state-btn.is-pending:hover { background: #fef8ee; }
body.staff-site .payment-state-btn.is-pending::before { background: #cb912f; }

body.staff-site .pickup-complete-btn { background: #2383e2; color: #fff; border: none; font-weight: 500; padding: 0 10px; }
body.staff-site .pickup-complete-btn:hover { background: #1b6ec2; color: #fff; }
body.staff-site .pickup-undo-btn { background: transparent; color: #787774; border: none; }
body.staff-site .pickup-undo-btn:hover { background: #f0f0ef; color: #37352f; }

/* ── Staff warehouse ── */
body.staff-site #staff-orders-table .warehouse-btn { border: none; background: transparent; color: #a5a5a3; font-size: 11px; }
body.staff-site #staff-orders-table .warehouse-btn:hover { background: #f0f0ef; color: #37352f; }
body.staff-site #staff-orders-table .warehouse-btn.is-active { background: #37352f; color: #fff; }
body.staff-site #staff-orders-table .warehouse-btn.is-active:hover { background: #4b4b48; }

body.staff-site #staff-orders-table .cancel-btn { border: none; font-size: 11px; }
body.staff-site #staff-orders-table tbody tr:hover .cancel-btn { color: #e03e3e; }
body.staff-site #staff-orders-table .cancel-btn:hover { background: #fce8e8; border: none; color: #e03e3e; }

body.staff-site #staff-orders-table td[data-col-key="detail"] .btn-sm { color: #2383e2; font-weight: 500; }
body.staff-site #staff-orders-table td[data-col-key="detail"] .btn-sm:hover { background: #e8f0fe; color: #1b6ec2; }

/* ── Staff warehouse row ── */
body.staff-site #staff-orders-table tbody tr.is-in-warehouse { background: #f7f7f5; border-left: 3px solid #787774; }
body.staff-site #staff-orders-table tbody tr.is-in-warehouse:nth-child(even) { background: #f7f7f5; }
body.staff-site #staff-orders-table tbody tr.is-in-warehouse:hover { background: #efefed; }

body.staff-site #staff-orders-table tbody tr.is-extension { border-left-color: #a78bfa; background: rgba(167, 139, 250, 0.04); }
body.staff-site .extension-badge { background: #a78bfa; border-radius: 3px; font-size: 9px; padding: 1px 4px; }

/* ── Staff tag pill — preserve color borders (high specificity) ── */
body.staff-site #staff-orders-table .tag-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; padding: 3px 10px; border-radius: 999px !important; font-weight: 800; font-size: 13px; border-bottom: none !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-orange { color: #c2410c !important; background: #fff7ed !important; border: 1.5px solid #fb923c !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-blue { color: #1e40af !important; background: #eff6ff !important; border: 1.5px solid #60a5fa !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-yellow { color: #92400e !important; background: #fefce8 !important; border: 1.5px solid #facc15 !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-green { color: #166534 !important; background: #f0fdf4 !important; border: 1.5px solid #4ade80 !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-purple { color: #6b21a8 !important; background: #faf5ff !important; border: 1.5px solid #a78bfa !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-black { color: #1a202c !important; background: #f1f5f9 !important; border: 1.5px solid #64748b !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-gray { color: #475569 !important; background: #f8fafc !important; border: 1.5px solid #94a3b8 !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-pink { color: #9d174d !important; background: #fdf2f8 !important; border: 1.5px solid #f472b6 !important; }
body.staff-site #staff-orders-table .tag-pill.tag-color-brown { color: #78350f !important; background: #fffbeb !important; border: 1.5px solid #d97706 !important; }

body.staff-site .price-amount { color: #37352f; font-weight: 600; font-size: 13px; }

/* ── Staff bulk action bar ── */
body.staff-site .bulk-action-bar {
  border-radius: 0;
  background: #37352f;
  padding: 8px 24px;
  box-shadow: none;
  animation: none;
  margin-bottom: 0;
}

body.staff-site .bulk-action-bar .btn-sm { border-radius: 4px; height: 26px; font-size: 12px; font-weight: 500; }
body.staff-site .bulk-action-bar .btn-primary { background: #4dab9a; border-color: #4dab9a; }
body.staff-site .bulk-action-bar .cancel-btn { background: #e03e3e; border-color: #e03e3e; }
body.staff-site .bulk-action-bar .warehouse-btn { background: #787774; border-color: #787774; color: #fff; }

/* ── Staff discount/manual ── */
body.staff-site .discount-details { border: 1px solid #e5e5e5; border-radius: 4px; background: #ffffff; padding: 12px; }
body.staff-site .discount-summary { color: #37352f; font-size: 13px; font-weight: 600; }
body.staff-site .discount-summary::after { background: #f0f0ef; color: #787774; border-radius: 4px; width: 20px; height: 20px; font-size: 14px; }

/* ── Staff controls ── */
body.staff-site .control {
  border: 1px solid #e5e5e5;
  background: #ffffff;
  border-radius: 4px;
  box-shadow: none;
  min-height: 32px;
  padding: 6px 10px;
  font-size: 13px;
}

body.staff-site .control:focus { border-color: #2383e2; box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.12); }

body.staff-site form { margin-top: 12px; }
body.staff-site .field-label { font-size: 11px; color: #787774; font-weight: 600; }
body.staff-site .field-hint { color: #a5a5a3; font-size: 11px; }

body.staff-site .admin-tools { margin-top: 8px; }
body.staff-site .admin-tools .btn { font-size: 12px; min-height: 28px; padding: 4px 10px; }

body.staff-site .error { border-radius: 4px; font-size: 12px; }
body.staff-site .success-note { border-radius: 4px; font-size: 12px; }

body.staff-site .bulk-check, body.staff-site #bulk-select-all { accent-color: #2383e2; }
body.staff-site .check-row input[type="checkbox"] { accent-color: #2383e2; }

body.staff-site .manual-late-warning { border-radius: 4px; }

body.staff-site .staff-menu {
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 4px 24px 8px;
  gap: 2px;
  border-bottom: 1px solid #e5e5e5;
}

body.staff-site .staff-menu-link {
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #787774;
  font-size: 13px;
  font-weight: 500;
  padding: 5px 10px;
  box-shadow: none;
}

body.staff-site .staff-menu-link:hover { background: #f7f7f5; color: #37352f; }

body.staff-site .staff-menu-link.is-active {
  background: #f0f0ef;
  color: #37352f;
  font-weight: 600;
  box-shadow: none;
}

body.staff-site .grid2 {
  grid-template-columns: repeat(auto-fit, minmax(240px, 420px));
  justify-content: flex-start;
}

body.staff-site .summary-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 320px));
  justify-content: flex-start;
}

body.staff-site .detail-action-grid {
  grid-template-columns: repeat(auto-fit, minmax(280px, 420px));
  justify-content: flex-start;
}

/* ── Staff Login Page ── */
body.staff-site .login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 52px);
  padding: 32px 16px;
}

body.staff-site .login-card {
  width: 100%;
  max-width: 380px;
  background: #ffffff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 40px 36px 32px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

body.staff-site .login-header { text-align: center; margin-bottom: 28px; }

body.staff-site .login-logo {
  width: 52px;
  height: 52px;
  object-fit: contain;
  mix-blend-mode: multiply;
  margin-bottom: 16px;
}

body.staff-site .login-title { font-size: 22px; font-weight: 700; color: #37352f; letter-spacing: -0.02em; margin: 0; }
body.staff-site .login-subtitle { font-size: 13px; color: #a5a5a3; margin: 6px 0 0; }

body.staff-site .login-card .btn-google {
  width: 100%;
  padding: 11px 16px;
  border-radius: 6px;
  font-size: 14px;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  color: #37352f;
  justify-content: center;
}

body.staff-site .login-card .btn-google:hover { background: #f7f7f5; border-color: #d5d5d3; }

body.staff-site .login-card .login-divider { margin: 20px 0 8px; color: #c0c0be; font-size: 12px; }
body.staff-site .login-card .login-divider::before,
body.staff-site .login-card .login-divider::after { background: #ebebea; }

body.staff-site .login-card form { margin-top: 12px; }
body.staff-site .login-card .field { margin-bottom: 16px; }

body.staff-site .login-card .control { min-height: 38px; padding: 9px 12px; font-size: 14px; border-radius: 6px; }
body.staff-site .login-card .control::placeholder { color: #c8c8c6; }

body.staff-site .login-card .btn-primary {
  width: 100%;
  padding: 11px 16px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 6px;
  margin-top: 4px;
}

body.staff-site .login-customer-link {
  display: block;
  text-align: center;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #ebebea;
  font-size: 13px;
  color: #a5a5a3;
  text-decoration: none;
}

body.staff-site .login-customer-link:hover { color: #37352f; }

/* ── Luggage hover card ── */
body.staff-site .luggage-hover-card { border: 1px solid #e5e5e5; border-radius: 6px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); }
body.staff-site .luggage-hover-card img { border-radius: 4px; }

body.staff-site .col-resize-handle::after { background: rgba(35, 131, 226, 0.4); }

/* ═══════════════════════════════════════════════════
   END NOTION-STYLE OVERRIDES
   ═══════════════════════════════════════════════════ */

/* ── Animation ── */
@keyframes riseIn {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Responsive ── */
@media (max-width: 860px) {
  .grid2, .grid3, .summary-grid, .detail-action-grid, .pickup-time-grid, .preview-with-options {
    grid-template-columns: 1fr;
  }

  .staff-search-row { grid-template-columns: 1fr; }
  .hero-row { align-items: flex-start; flex-direction: column; }

  .topbar-inner { flex-direction: row; align-items: center; padding: 8px 14px; gap: 8px; }
  .brand-logo { width: 28px; height: 28px; }
  .brand { font-size: 14px; gap: 7px; white-space: nowrap; }

  .pill-nav { flex: 0 1 auto; width: auto; justify-content: flex-end; flex-wrap: nowrap; gap: 4px; }
  .pill-link { font-size: 12px; padding: 5px 10px; min-height: unset; white-space: nowrap; }

  .button-wrap { margin-top: -2px; }
  .button-wrap .btn, .button-wrap button { width: 100%; }

  .card { padding: 18px; border-radius: 20px; }

  body.staff-site .hero { padding: 16px 16px 4px; }
  body.staff-site .card { padding: 12px 0; }
  body.staff-site .staff-menu { padding: 4px 16px 8px; }
  body.staff-site .bulk-action-bar { padding: 8px 16px; }
  body.staff-site .topbar-inner { padding: 8px 16px; }

  .cash-denom-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cash-summary-grid { grid-template-columns: 1fr; }

  .account-create-grid, .account-update-grid { grid-template-columns: 1fr; }
}

/* ── Print ── */
@media print {
  .topbar, .pill-nav, .staff-menu, .fab-bug-report, button, .btn, .no-print { display: none !important; }
  body { background: #fff; color: #000; font-size: 12pt; }
  table { box-shadow: none; border: 1px solid #ccc; }
  th, td { border: 1px solid #ccc; padding: 6pt 8pt; }
  a { color: #000; text-decoration: none; }
}
`;

staticRoutes.get("/static/styles.css", (c) => {
  return c.text(CSS_CONTENT, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

export default staticRoutes;
