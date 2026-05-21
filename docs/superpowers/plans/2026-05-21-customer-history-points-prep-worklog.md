# Customer History And Points Prep Work Log

## 2026-05-21 WORK

진행 요약:
- Account `person_id`를 주문과 연결할 수 있도록 `account_person_id` 기반 nullable 스키마를 추가했다.
- 포인트 잔액 스냅샷과 포인트 거래 원장 테이블을 추가했다.
- 최근 이력 조회와 포인트 잔액 조회를 담당하는 customer context 서비스를 추가했다.
- 포인트 사용량 계산과 주문 수금액 계산 helper를 추가했다.
- 관리 매출과 운영 정산의 주문 금액 집계가 공통 helper SQL을 쓰도록 변경했다.
- live route는 migration 선적용 없이도 배포할 수 있도록 기존 컬럼만 참조하는 호환 모드로 연결했다.

최종 변경 파일 목록:
- `worker/src/schema.sql`
- `worker/migrations/20260521_customer_history_points_prep.sql`
- `worker/src/types.ts`
- `worker/src/services/customerContext.ts`
- `worker/src/services/customerContext.test.ts`
- `worker/src/services/points.ts`
- `worker/src/services/points.test.ts`
- `worker/src/services/orderAmounts.ts`
- `worker/src/services/orderAmounts.test.ts`
- `worker/src/routes/admin.tsx`
- `worker/src/routes/operations.tsx`

체크리스트:
- [x] W1 일부: `luggage_customer_profiles` 추가.
- [x] W1 일부: `luggage_customer_point_accounts` 추가.
- [x] W1 일부: `luggage_customer_point_transactions` 추가.
- [x] W1 일부: `luggage_orders`에 계정/포인트/이전 preset 준비 컬럼 추가.
- [x] W1 일부: 최근 이력/포인트 조회용 인덱스 추가.
- [x] W2 일부: `CustomerSession`, `CustomerProfile`, `RecentCustomerOrder`, `CustomerContext` 타입 추가.
- [x] W2 일부: `getCurrentCustomer`, `loadCustomerContext`, `loadRecentCustomerOrders`, `loadPointBalance` 추가.
- [x] 선행 안정화: 포인트 전액 사용/패스 전액 할인 시 매출 집계가 `prepaid_amount`로 되튀지 않는 주문 금액 helper 추가.

실행 명령어 및 결과:
- `pnpm --dir worker test src/services/orderAmounts.test.ts src/services/points.test.ts src/services/customerContext.test.ts` -> 통과, 3 files / 14 tests.
- `pnpm --dir worker typecheck` -> 통과.
- `pnpm --dir worker test` -> 통과, 12 files / 50 tests.

커밋:
- 없음. 사용자가 커밋을 요청하지 않아 작업트리에만 반영했다.

주의할 리스크:
- 실제 고객 context/포인트 UI를 route에 연결하기 전에는 `worker/migrations/20260521_customer_history_points_prep.sql` 적용이 필요하다.
- SQLite/D1은 `ALTER TABLE ADD COLUMN IF NOT EXISTS`를 지원하지 않으므로 migration 재실행 전 `schema_migrations` 확인이 필요하다.
- 실제 포인트 적립/차감 hook과 고객 폼 UI는 아직 구현하지 않았다.

Completed checklist items in this WORK:
- W1 schema/migration foundation, W2 customer context foundation, amount aggregation helper foundation.

Validations passed in this state:
- Targeted service tests, full worker test suite, and worker typecheck.

Risk points to watch in Review (if any):
- Deploy/migration ordering and existing schema drift around `view_token` / `luggage_referral_counts`.
