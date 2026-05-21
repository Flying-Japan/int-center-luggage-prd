# Customer History And Points Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회원가입/로그인 구현과 독립적으로, 로그인 고객이 최근 접수 이력을 눌러 일부 필드를 채우고 포인트를 사용할 수 있는 기반을 만든다.

**Architecture:** 인증 자체는 이 계획의 범위 밖으로 두고, `pub-account-prd`가 발급/보유하는 canonical `person_id`를 optional customer context로 주입받는 구조를 둔다. Luggage는 자체 customer id를 발급하지 않고, 주문에는 `account_person_id`와 포인트 스냅샷만 저장하며 포인트 잔액은 Luggage 전용 원장으로 관리한다.

**Tech Stack:** Cloudflare Workers, Hono, Cloudflare D1, R2, TypeScript, Vitest.

---

요약:
- 고객 가입/로그인 화면은 만들지 않는다.
- `pub-account-prd`의 account ledger-first 방향을 따른다. Luggage는 `person_id` 소비자이지 identity authority가 아니다.
- 로그인 고객 context가 들어왔을 때만 프로필 표시, 최근 이력 카드, 포인트 UI가 열린다.
- 최근 이력은 자동 적용하지 않고 사용자가 버튼을 눌렀을 때만 수량/일행/결제수단을 채운다.
- 포인트는 접수 시 예약 차감, 결제 완료 시 확정, 취소/결제취소 시 되돌림으로 설계한다.
- 실제 구현 전 승인할 정책은 인증 handoff, 적립률, 포인트 사용 단위다.

pub-account-prd 참고 반영:
- Account v1은 로그인 권한자가 아니라 ledger/API dependency로 정의되어 있고 canonical `person_id`, `identities`, `service_memberships`를 소유한다. Evidence: `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/docs/architecture.md:5`, `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/supabase/migrations/0001_account_v1.sql:99`, `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/supabase/migrations/0001_account_v1.sql:111`.
- Trip internal endpoint는 authenticated service가 `external_id`를 보내면 Account가 `person_id`를 upsert하는 구조다. Evidence: `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/src/app/internal/persons/route.ts:7`.
- Account internal writes는 bearer auth, `Idempotency-Key`, schema validation, audit logging wrapper를 통과한다. Evidence: `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/src/lib/internal/handler.ts:16`.
- 같은 email 자동 merge는 금지되어 있다. Luggage도 email 기반 고객 매칭을 하지 않는다. Evidence: `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/docs/adr/0008-no-automatic-merge.md:8`.
- 포인트 구현은 `pub-account-prd`에서 발견되지 않았다. 따라서 포인트는 Luggage 서비스 로컬 원장으로 시작하되, key는 Account `person_id`를 사용한다.

## 1. Goal / scope / out-of-scope

Goal:
- `/customer` 폼에 로그인 고객용 준비 레이어를 추가한다.
- 로그인 고객은 이름/전화/email 프로필을 서버 값으로 사용하고, 최근 접수 이력을 읽기 전용 카드로 확인한 뒤 `이번 접수에 적용` 버튼으로 일부 필드를 채울 수 있다.
- 로그인 고객은 보유 포인트를 접수 양식에서 사용할 수 있다.
- 포인트 잔액은 단순 컬럼 하나가 아니라 원장 기반으로 관리한다.

Scope:
- D1 스키마와 migration 추가.
- `pub-account-prd`의 `person_id`를 받을 수 있는 `customer` context 타입/adapter 추가.
- Luggage 서비스 로컬 프로필 캐시를 `account_person_id` 기준으로 추가.
- 최근 이력 조회 서비스 추가.
- 포인트 계산/원장 서비스 추가.
- 고객 접수 폼/제출 처리/가격 preview의 포인트 준비.
- 직원 결제 완료, 결제 취소, 주문 취소 경로의 포인트 hook 추가.
- Vitest 단위/라우트 테스트 추가.

Out-of-scope:
- 회원가입, 로그인, 비밀번호, OAuth 화면 구현.
- `pub-account-prd`의 회원가입/로그인 구현 변경.
- Account `person_id` 발급 endpoint 구현. 단, Luggage 연동에 필요한 계약은 문서화한다.
- 고객 마이페이지, 포인트 상세 내역 페이지.
- 운영자용 포인트 수동 조정 UI.
- 기존 Flying Pass 할인 정책 개편.

가정(승인 필요):
- 로그인 구현은 나중에 Hono context variable `customer`를 세팅한다.
- 로그인 구현은 `pub-account-prd`의 canonical `person_id`를 `customer.personId`로 세팅한다.
- `luggage_customer_profiles`는 canonical identity가 아니라 Luggage 접수용 연락처/표시 정보 캐시다.
- 포인트는 `1P = ¥1`로 사용한다.
- 적립률은 실제 결제 금액의 1%로 시작한다.

## 2. Defect or requirement matrix

| Requirement | Plan item | Evidence |
| --- | --- | --- |
| 최근 이력은 자동 입력하지 않는다 | `customerHistory` 카드와 JS 버튼 handler만 추가 | 현재 수량/결제 필드는 폼 내부 select/radio로 직접 입력됨: `worker/src/routes/customer.tsx:692`, `worker/src/routes/customer.tsx:783` |
| 최근 이력 적용 대상은 수량/일행/결제수단만 | `applyRecentOrderPreset()`이 `suitcase_qty`, `backpack_qty`, `companion_count`, `payment_method`만 변경 | 현재 해당 필드 위치: `worker/src/routes/customer.tsx:695`, `worker/src/routes/customer.tsx:718`, `worker/src/routes/customer.tsx:792`, `worker/src/routes/customer.tsx:819` |
| 사진/수령일/동의는 매번 새로 받는다 | 최근 이력 payload에 사진/수령일/동의 값을 넣지 않음 | 사진 required: `worker/src/routes/customer.tsx:671`, `worker/src/routes/customer.tsx:681`; 수령일 hidden: `worker/src/routes/customer.tsx:643`; 동의 검증: `worker/src/routes/customer.tsx:1457` |
| 로그인 고객은 Account `person_id`와 서버 프로필 값을 사용한다 | `getCurrentCustomer()`와 `loadCustomerContext()` 추가, submit에서 서버 profile 우선 | 현재 submit은 body에서 name/phone/email을 신뢰함: `worker/src/routes/customer.tsx:1435`; Account는 `persons`와 `identities`를 소유함: `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/supabase/migrations/0001_account_v1.sql:99`, `/Users/sanghunbruceham/Documents/GitHub/pub-account-prd/supabase/migrations/0001_account_v1.sql:111` |
| 포인트 사용은 서버에서 잔액/주문 금액으로 cap 처리한다 | `calculatePointUsage()`와 submit-side validation | 현재 가격 계산은 submit에서 최종 수행됨: `worker/src/routes/customer.tsx:1528` |
| 결제 완료 시 적립한다 | `staffApi`와 `staffOrders` mark paid hook | 결제 완료 경로: `worker/src/routes/staffApi.ts:374`, `worker/src/routes/staffOrders.tsx:340` |
| 취소/결제취소 시 원장 되돌림 | cancel/toggle payment/bulk action hook | 취소 경로: `worker/src/routes/staffApi.ts:233`; bulk action: `worker/src/routes/staffApi.ts:250` |

## 3. Invariant protection strategy

- Guest 접수는 현재와 동일하게 동작해야 한다. `getCurrentCustomer()`가 null이면 기존 name/phone/email input, 신분증 사진 required, 포인트 UI hidden 상태를 유지한다.
- 주문 번호/짐 번호 allocation은 이미지 업로드 성공 후에만 실행되는 현재 순서를 유지한다. Evidence: `worker/src/routes/customer.tsx:1477`, `worker/src/routes/customer.tsx:1510`.
- 포인트로 전액 결제해 `final_amount = 0`이 되어도 매출 집계가 기존 `NULLIF(final_amount, 0)` fallback 때문에 gross amount로 오인되지 않게 수정한다. Evidence: 현재 admin 매출 집계는 `NULLIF(final_amount, 0)`를 사용함: `worker/src/routes/admin.tsx:50`.
- 포인트 차감은 idempotency key로 중복 실행을 막는다.
- 고객이 보낸 `account_person_id`, `point_balance`, `name`, `phone`, `email` hidden 값은 신뢰하지 않는다.
- Luggage는 email/phone으로 `person_id`를 추정하거나 자동 merge하지 않는다. Account ADR 0008에 따라 같은 email도 강한 식별자로 보지 않는다.
- Account service-role key는 Luggage에 주입하지 않는다. 필요한 경우 Account가 별도 Luggage bearer token을 발급하고 server-to-server endpoint만 호출한다.
- 최근 이력 적용 버튼은 클라이언트 편의 기능일 뿐이며 submit 검증은 서버에서 다시 수행한다.
- D1에서 트랜잭션 경계가 제한될 수 있으므로, 포인트 잔액 차감은 조건부 update와 idempotent transaction insert 순서로 구성한다.

## 4. Policy decision table

| Decision | Proposed value | Reason | Approval |
| --- | --- | --- | --- |
| Identity owner | `pub-account-prd`의 `person_id` | Flying 서비스 간 identity 충돌/merge 리스크를 줄임 | 승인 필요 |
| Luggage local profile | `account_person_id` 기준 연락처 캐시 | Account v1 schema에는 이름/전화가 없어서 접수 편의 정보는 서비스 로컬에 필요 | 승인 필요 |
| Point value | `1P = ¥1` | 고객에게 설명이 쉽고 계산 오류가 적음 | 승인 필요 |
| Minimum use | `100P` 단위, 전액 사용은 잔액/결제금액 중 작은 값으로 내림 | 소액 잔액 난립 방지 | 승인 필요 |
| Earn rate | 실제 결제 금액의 `1%`, 소수점 버림 | 첫 버전 운영 부담 낮음 | 승인 필요 |
| Earn timing | `PAYMENT_PENDING -> PAID` 시점 | 미결제 주문 적립 방지 | 승인 필요 |
| Use timing | 접수 submit 시 `RESERVED` 차감, `PAID` 시 확정 | 중복 사용 방지 | 승인 필요 |
| Release timing | `CANCELLED` 또는 `PAID -> PAYMENT_PENDING` 시 보정 | 직원 실수/취소 대응 | 승인 필요 |
| Recent history count | 최근 3건 | 과도한 선택지 방지 | 승인 가능 |
| History source statuses | `PAID`, `PICKED_UP`, `PAYMENT_PENDING`; `CANCELLED` 제외 | 실제 접수 이력만 추천 | 승인 가능 |
| Identity photo skip | `identity_verified_at`이 있으면 id photo optional | 인증 작업과 연결 | 회원가입 작업과 합의 필요 |

## 5. Completion criteria (DoD, 측정 가능)

- Guest `/customer`는 기존 필수 필드와 submit validation이 깨지지 않는다.
- Authenticated context가 있으면 `/customer` HTML에 프로필 요약, 최근 이력 최대 3개, 보유 포인트/사용 포인트 UI가 표시된다.
- 최근 이력 카드 버튼을 누르면 캐리어 수량, 백팩 수량, 일행 수, 결제수단만 변경되고 수령 예정일시, 사진, 동의는 변경되지 않는다.
- `/api/price-preview`는 points 입력을 반영해 `gross_amount`, `points_to_use`, `final_prepaid` 또는 equivalent 값을 반환한다.
- Submit은 points 사용량을 서버에서 잔액/금액 기준으로 cap 처리하고 주문에 `account_person_id`, `points_used`, `points_earned`, `point_usage_status`를 저장한다.
- 결제 완료 시 적립 transaction이 한 번만 생성된다.
- 취소 또는 결제 취소 시 reserved/posted point use가 중복 없이 되돌려진다.
- `pnpm --dir worker test`와 `pnpm --dir worker typecheck`가 통과한다.
- 포인트 전액 사용 주문의 매출 집계가 `prepaid_amount`로 되튀지 않는다.
- rollback은 migration 적용 전이면 코드 revert만으로 가능하고, migration 적용 후이면 새 nullable 컬럼/테이블이 기존 guest flow에 영향이 없다.

## 6. Candidate changed files + rationale

- Modify: `worker/src/schema.sql`
  - 신규 customer/point 테이블과 order nullable 컬럼을 base schema에 반영.
- Create: `worker/migrations/20260521_customer_history_points_prep.sql`
  - 운영 D1에 nullable 확장 적용.
- Modify: `worker/src/types.ts`
  - `AppVariables.customer?: CustomerSession`와 Account 연동 env 타입 추가.
- Create: `worker/src/lib/accountClient.ts`
  - 추후 Account internal API를 호출해야 할 경우를 위한 typed client와 bearer/idempotency 규칙 캡슐화. 실제 호출은 로그인 handoff 확정 후 사용한다.
- Create: `worker/src/services/customerContext.ts`
  - Account `person_id` 기반 인증 handoff, Luggage profile 조회, 최근 주문 조회, 포인트 잔액 조회를 캡슐화.
- Create: `worker/src/services/points.ts`
  - 포인트 사용량 계산, 예약/확정/해제/적립 idempotent 처리.
- Modify: `worker/src/routes/customer.tsx`
  - GET `/customer`를 async로 전환하고 로그인 customer context에 따라 UI/JS/submit 처리 확장.
- Modify: `worker/src/routes/staffApi.ts`
  - JSON staff 결제/취소/bulk 경로에 포인트 hook 추가.
- Modify: `worker/src/routes/staffOrders.tsx`
  - HTML staff 결제 경로에 포인트 hook 추가, 상세 요약에 포인트 사용/적립 표시.
- Modify: `worker/src/routes/admin.tsx`
  - 매출 계산이 포인트 전액 사용 주문을 잘못 집계하지 않게 금액 expression 조정.
- Create: `worker/src/services/customerContext.test.ts`
  - 최근 이력 조회와 guest fallback 테스트.
- Create: `worker/src/services/points.test.ts`
  - 포인트 계산, 예약, 중복 방지, 해제 테스트.
- Create or modify: `worker/src/routes/customer.test.ts`
  - 고객 HTML/preview/submit integration 테스트.
- Modify if needed: `worker/src/routes/static.test.ts`
  - 변경 없음 예상. CSS/JS가 inline이라 정적 manifest 변경은 필요 없다.

## 7. Stagewise Work checklist (W1-Wn, validation command per stage)

### W1: Schema and migration

- [x] Add `luggage_customer_profiles` keyed by Account `person_id`.
- [x] Add `luggage_customer_point_accounts`.
- [x] Add `luggage_customer_point_transactions`.
- [x] Add nullable columns to `luggage_orders`: `account_person_id`, `points_used`, `points_earned`, `point_usage_status`, `source_preset_order_id`.
- [x] Add indexes: recent order lookup by `(account_person_id, created_at)`, point transactions by `(account_person_id, created_at)`, unique `idempotency_key`.
- [x] Validation command: `pnpm --dir worker typecheck`.

Suggested D1 shape:

```sql
CREATE TABLE IF NOT EXISTS luggage_customer_profiles (
  account_person_id TEXT PRIMARY KEY,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  locale TEXT,
  identity_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS luggage_customer_point_accounts (
  account_person_id TEXT PRIMARY KEY,
  balance_points INTEGER NOT NULL DEFAULT 0,
  lifetime_earned_points INTEGER NOT NULL DEFAULT 0,
  lifetime_used_points INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS luggage_customer_point_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_person_id TEXT NOT NULL,
  order_id TEXT,
  transaction_type TEXT NOT NULL,
  points_delta INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  balance_after INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### W2: Customer context adapter

- [x] Add `CustomerSession`, `CustomerProfile`, `RecentCustomerOrder`, `CustomerContext` types.
- [x] Add `getCurrentCustomer(c)` that returns `c.get("customer") ?? null`.
- [x] Add `loadCustomerContext(c)` that returns guest context when no customer exists.
- [x] Add `loadRecentCustomerOrders(db, accountPersonId, limit = 3)`.
- [x] Add `loadPointBalance(db, accountPersonId)`.
- [x] Validation command: `pnpm --dir worker test src/services/customerContext.test.ts`.

Integration contract for separate signup/login work:

```ts
export type CustomerSession = {
  personId: string;
  email?: string;
  provider: string;
  issuedBy: "pub-account";
};
```

### W3: Point service

- [x] Add `calculatePointUsage({ requestedPoints, balancePoints, payableAmount, minimumUnit })`.
- [x] Add `reservePointUseForOrder(db, input)` using idempotency key `point:reserve:${orderId}`.
- [x] Add `commitReservedPointUseForOrder(db, orderId)` with no balance delta, only status transition.
- [x] Add `releaseReservedPointUseForOrder(db, orderId)` that inserts a positive release transaction once.
- [x] Add `postEarnedPointsForPaidOrder(db, orderId)` using idempotency key `point:earn:${orderId}`. Paid amount is resolved from the order row via `calculateOrderCollectedAmount`, so the helper is callable from any status-transition path without an extra argument.
- [x] Add `voidEarnedPointsForOrder(db, orderId)` for payment reversal.
- [x] Validation command: `pnpm --dir worker test src/services/points.test.ts`.

Core calculation:

```ts
export function calculatePointUsage(input: {
  requestedPoints: number;
  balancePoints: number;
  payableAmount: number;
  minimumUnit: number;
}) {
  const requested = Math.max(0, Math.floor(input.requestedPoints || 0));
  const capped = Math.min(requested, input.balancePoints, input.payableAmount);
  const usable = capped === input.payableAmount ? capped : Math.floor(capped / input.minimumUnit) * input.minimumUnit;
  return { pointsToUse: usable, amountAfterPoints: Math.max(0, input.payableAmount - usable) };
}
```

### W4: Customer form UI

- [x] Make `customer.get("/customer")` async.
- [x] Load customer context once at the top of GET.
- [x] Render profile summary for authenticated customer (account card above the form).
- [x] Keep existing name/phone/email inputs for guest. (Guest path is unchanged — the conditional account card is the only addition.)
- [~] For authenticated customer, render profile values as non-editable summary and submit hidden marker only. Profile summary is rendered. Form inputs are still visible/editable to authenticated users but the server-side handler ignores body values in favour of the trusted profile (spoof-safe). Read-only input styling is deferred to the signup PR.
- [x] Render recent history cards with JSON payload containing only `order_id`, `suitcase_qty`, `backpack_qty`, `companion_count`, `payment_method`. Photos / pickup time / consent are intentionally excluded.
- [x] Add JS `applyRecentOrderPreset(payload)` that updates suitcase / backpack / companion select-and-custom controls and the payment radio. Bound via event delegation on `#recent-orders`.
- [x] Validation: typecheck + targeted service tests. Route-level integration tests for `customer.tsx` are deferred — no `customer.test.ts` exists yet; new code paths are gated behind `isAuthenticated` which is always false until the signup work injects a context.

Recent card payload rule:

```ts
const payload = {
  order_id: row.order_id,
  suitcase_qty: row.suitcase_qty,
  backpack_qty: row.backpack_qty,
  companion_count: row.companion_count,
  payment_method: row.payment_method,
};
```

### W5: Points preview UI

- [x] Render point balance and number input only for authenticated customers (inside the account card, gated on `customerContext.pointBalance > 0`).
- [x] Add `전액사용` button that fills the maximum currently available value client-side.
- [x] Include `points_to_use` in preview request — wired through `points_to_use_form` hidden mirror.
- [x] Update preview response rendering to show gross amount, point discount, final payment amount. The point card now shows `gross - usedP = final`.
- [x] Server-side preview caps points by authenticated customer balance via `calculatePointUsage`.
- [x] Validation: typecheck + service tests.

Preview response shape:

```ts
{
  prepaid_amount: number,
  flying_pass_discount_amount: number,
  gross_payable_amount: number,
  points_to_use: number,
  final_prepaid: number
}
```

### W6: Submit flow

- [x] Load customer context in POST `/customer/submit`.
- [x] If authenticated and profile has name/phone/email, use profile values instead of body values (`trustedProfile` override).
- [x] If authenticated profile is missing required contact fields, the existing required-field redirects fire on the merged values, so an authenticated user with an incomplete profile falls through to the same `required: name/phone/email` error as a guest. Profile-specific copy is deferred to the signup PR.
- [x] Calculate gross payable after existing long-stay/Flying Pass rules (`grossPayableAmount = prepaidAmount - passDiscount`).
- [x] Cap and reserve point use before order insert. Server caps via `calculatePointUsage`, then reserves via `reservePointUseForOrder` keyed by `point:reserve:<orderId>`.
- [x] Insert order with `account_person_id`, `gross_amount`, `point_discount_amount`, `points_used`, `point_usage_status`.
- [x] On order insert failure, release any reserved points via `releaseReservedPointUseForOrder` and delete orphan R2 images.
- [x] Validation: typecheck + service tests; route-level integration tests deferred (no `customer.test.ts` in workspace yet).

Compensation invariant:
- If image upload succeeds but order insert fails, existing R2 cleanup remains.
- If point reservation succeeds but order insert fails, point release must run before redirect.

### W7: Staff payment hooks

- [x] In `staffOrders.post("/staff/orders/:id/mark-paid")`, after successful status update, commit reserved use and post earned points.
- [x] In `staffApi.post("/staff/api/orders/:id/toggle-payment")`, when transitioning to `PAID`, commit/earn; when transitioning back to `PAYMENT_PENDING`, void earned points. Reserved points are kept so the order can return to `PAID` without losing its reservation.
- [x] In `staffApi.post("/staff/api/orders/bulk-action")`, apply the same point logic per affected order.
- [x] In `staffApi.post("/staff/api/orders/:id/cancel")`, release reserved use and void earned points once.
- [x] Validation command: matrix tests on `applyPointEffectsForStatusChange` in `points.test.ts` (PAID/CANCELLED/PAYMENT_PENDING transitions). Route-level integration tests deferred — no `staffApi.test.ts` / `staffOrders.test.ts` exists yet in the workspace.

Required helper:

```ts
export async function applyPointEffectsForStatusChange(db: D1Database, input: {
  orderId: string;
  fromStatus: string;
  toStatus: string;
}) {
  if (fromStatus === toStatus) return;
  if (toStatus === "PAID") {
    await commitReservedPointUseForOrder(db, input.orderId);
    await postEarnedPointsForPaidOrder(db, input.orderId);
  }
  if (toStatus === "CANCELLED") {
    await releaseReservedPointUseForOrder(db, input.orderId);
    await voidEarnedPointsForOrder(db, input.orderId);
  }
  if (fromStatus === "PAID" && toStatus === "PAYMENT_PENDING") {
    await voidEarnedPointsForOrder(db, input.orderId);
  }
}
```

### W8: Admin and staff display

- [x] Add staff order detail rows: 포인트 사용 + 포인트 적립 + 사용 상태 (`point_usage_status`). Row is hidden when both `points_used` and `points_earned` are 0, so guest/legacy orders look identical to before.
- [x] Adjust admin revenue SQL expression so point-covered `final_amount = 0` does not fallback to `prepaid_amount`. Both `admin.tsx` and `operations.tsx` now use `orderCollectedAmountSql()` from `services/orderAmounts.ts` instead of the legacy `COALESCE(NULLIF(final_amount, 0), prepaid_amount)` pattern.
- [x] Keep guest/legacy order display unchanged when `points_used = 0`.
- [x] Validation command: `pnpm --dir worker test && pnpm --dir worker typecheck`.

Revenue expression policy:

```sql
CASE
  WHEN points_used > 0 THEN final_amount
  WHEN final_amount > 0 THEN final_amount
  ELSE prepaid_amount
END
```

### W9: End-to-end verification

- [x] Run full tests: `pnpm --dir worker test` — 6 files / 44 tests passing.
- [x] Run typecheck: `pnpm --dir worker typecheck` — clean.
- [x] Start local worker: `pnpm --dir worker dev` — `HEAD /customer 200 OK (12ms)`.
- [x] Open `/customer?lang=ko` as guest and verify no logged-in widgets are visible. Confirmed via curl + grep: `customer-account-card`, `point-use-card`, and the `<div id="recent-orders">` element are all absent from guest HTML. The string "recent-orders" only appears inside the JS IIFE where `getElementById("recent-orders")` returns null behind an `if (recentOrdersEl)` guard.
- [ ] Use test-only customer context injection in route tests rather than browser auth for this phase. Deferred — no `customer.test.ts` exists yet in the workspace, and adding one purely for dead-path coverage is overkill. The signup PR will add real authenticated coverage.
- [ ] Verify recent card click updates only allowed fields. Deferred — requires authenticated context; payload contract is enforced by `recentOrderPresetPayload()` returning only the 4 whitelisted fields, and `applyRecentOrderPreset` mutates only suitcase / backpack / companion / payment_method.
- [ ] Verify point full-use preview with `final_prepaid = 0`. Deferred — requires authenticated context with non-zero balance; covered analytically by `calculatePointUsage` unit tests (full-payment exact branch).

## 8. Test plan (Red -> Green, happy/failure/boundary)

Red tests first:
- `calculatePointUsage` returns 0 for guest/no balance.
- `calculatePointUsage` caps at payable amount.
- `calculatePointUsage` rounds down to 100P except exact full payment.
- `reservePointUseForOrder` refuses negative balance.
- `reservePointUseForOrder` is idempotent for same order.
- `releaseReservedPointUseForOrder` restores balance once.
- `postEarnedPointsForPaidOrder` posts once for repeated `PAID` calls.
- `loadRecentCustomerOrders` excludes `CANCELLED` and limits to 3.
- Authenticated `/customer` contains recent history button payload but not old photos/pickup dates.
- Guest `/customer` does not contain point UI.
- Submit with authenticated profile ignores spoofed body name/email.
- Submit with authenticated Account context ignores spoofed `account_person_id`.
- Submit with points over balance caps to balance.
- Submit with full point use stores `final_amount = 0` and does not break success redirect.

Happy path:
- Authenticated customer with 1200P and recent paid order opens form, applies recent order, uses 1000P on a ¥2000 order, submits, order stores `points_used = 1000`, `final_amount = 1000`, `point_usage_status = RESERVED`.
- Staff marks order as paid, reserved use becomes posted and earned points are added once.

Failure path:
- Insufficient points requested: server caps, no negative balance.
- Order insert fails after point reservation: release transaction is inserted and R2 cleanup still runs.
- Staff cancels pending order: reserved points released once.
- Staff repeats mark paid: no duplicate earned points.

Boundary:
- Full point payment creates `final_amount = 0`.
- Custom quantity greater than 10 from recent history uses custom input branch.
- Recent order with null payment method defaults to current payment default without throwing.
- Customer profile missing email redirects with profile completion message.

## 9. Risks / regressions (P1/P2/P3 + 대응)

P1 - 포인트 double-spend:
- 대응: account balance conditional update, transaction idempotency key, tests for repeated submit/status calls.

P1 - 매출 집계 오염:
- 대응: admin/staff revenue expression update, full point payment test.

P1 - 개인정보 spoofing:
- 대응: authenticated submit uses server profile/context, not client hidden fields.

P1 - Account identity mismatch:
- 대응: only trust `customer.personId` from auth middleware; never look up or merge by email/phone in Luggage.

P2 - 기존 guest 접수 regression:
- 대응: customer route tests for guest HTML and submit validation, manual guest browser check.

P2 - Staff 상태 변경 경로 누락:
- 대응: `staffApi` JSON, `staffOrders` HTML, bulk action 모두 matrix로 확인.

P2 - D1 partial failure:
- 대응: compensation steps for point reservation release and R2 cleanup.

P3 - UI 복잡도 증가:
- 대응: logged-in widgets only render when authenticated; guest screen remains current layout.

## 10. Plan Drift rules (중단/승인 조건)

Stop and ask approval if:
- 회원가입 작업이 `c.set("customer")`가 아닌 다른 session handoff를 요구한다.
- 회원가입 작업이 Account `person_id`가 아닌 service-local user id만 제공한다.
- Account 쪽에 `luggage` service registration/internal endpoint changes가 필요해진다.
- 포인트 적립률, 최소 사용 단위, 만료 정책이 현재 제안과 다르다.
- 포인트를 접수 시점에 차감하지 않고 결제 시점에만 차감해야 한다는 운영 요구가 생긴다.
- D1 migration에 destructive change가 필요해진다.
- 기존 admin 매출 정의가 "실제 수금액"이 아니라 "서비스 정가" 기준이어야 한다는 요구가 확인된다.

Continue without approval if:
- 변경이 nullable 컬럼/신규 테이블 추가에 한정된다.
- guest flow 테스트가 깨지지 않는 CSS/HTML 문구 조정이다.
- 테스트 helper/fake DB 확장이 필요하다.

## 11. Review priority criteria

P1 review:
- 포인트 잔액 음수 가능성.
- status transition 중복으로 적립/차감 중복 가능성.
- authenticated submit에서 body spoofing 가능성.
- `account_person_id`를 email/phone에서 추정하는 코드가 들어갔는지 여부.
- full point payment 매출 집계 오류.

P2 review:
- 최근 이력 payload에 사진/수령일/동의가 포함되는지 여부.
- customer context null 처리 누락.
- point reservation 후 order insert 실패 compensation 누락.

P3 review:
- 문구/i18n 누락.
- 최근 이력 카드의 모바일 표시 품질.
- 테스트 이름/fixture 가독성.

## 12. Compound candidates (최소 1개)

- `worker/src/services/points.ts`의 idempotent point transaction helper는 이후 고객 마이페이지, 포인트 수동 조정, 환불 자동화에도 재사용 가능하다.
- `worker/src/services/customerContext.ts`의 Account `person_id` handoff contract는 회원가입 작업 완료 후 실제 customer auth middleware 연결 지점으로 재사용 가능하다.
- Admin revenue expression helper를 함수화하면 `admin.tsx`, cash closing, staff dashboard의 금액 기준 불일치를 줄일 수 있다.

## 13. User approval points (1-3)

1. 인증 handoff: 회원가입/로그인 작업이 로그인 고객을 `AppVariables.customer`에 `{ personId, email?, provider, issuedBy: "pub-account" }`로 넣어주는 방식으로 맞춰도 되는지.
2. 포인트 정책: `1P = ¥1`, 실제 결제금액 1% 적립, 100P 단위 사용, 전액 결제 예외 허용으로 시작해도 되는지.
3. 포인트 사용 시점: 접수 시 예약 차감하고 결제 완료 시 확정, 취소/결제취소 시 되돌리는 방식으로 운영할지.

PLAN COMPLETE — REQUEST WORK APPROVAL
