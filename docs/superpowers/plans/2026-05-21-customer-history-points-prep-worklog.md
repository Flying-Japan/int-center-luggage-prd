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

## 2026-05-21 WORK (resumed)

배경:
- 첫 세션의 작업물(70e20d8)은 `codex/phase3-experience-infra` 위에 끼어 있었고 worklog의 "최종 변경 파일 목록" 중 `types.ts`, `admin.tsx`, `operations.tsx` 변경분은 같은 워크트리에 섞여 있던 phase3 미커밋 변경분이라 실제 커밋에는 포함되지 않은 상태였다.
- PR을 깔끔하게 만들 수 있도록 `feature/customer-history-points-prep` 브랜치를 70e20d8에서 분기하고, 별도 워크트리(`int-center-luggage-points`)에서 W3 나머지를 진행했다.

진행 요약:
- `types.ts`에 `CustomerSession` 타입과 `AppVariables.customer?` 필드를 추가했다 (이전 세션에서 누락된 부분).
- `points.ts`에 포인트 원장 mutator 5개를 추가했다: 예약(`reservePointUseForOrder`), 확정(`commitReservedPointUseForOrder`), 해제(`releaseReservedPointUseForOrder`), 적립(`postEarnedPointsForPaidOrder`), 적립 취소(`voidEarnedPointsForOrder`).
- 모든 mutator는 idempotency key UNIQUE 제약과 D1 `batch()` atomic 실행으로 중복 호출을 안전하게 흡수한다.
- `postEarnedPointsForPaidOrder`는 paidAmount를 인자로 받지 않고 `luggage_orders` 행을 읽어 `calculateOrderCollectedAmount`로 계산한다. 덕분에 staff status 전환 경로에서 인자 동기화를 신경 쓸 필요가 없다.
- 적립률은 100 bps(1%)로 시작하며 상수 `POINT_EARN_RATE_BPS`로 노출했다. 정책 변경 시 한 군데만 수정한다.

최종 변경 파일 목록 (워크트리: `int-center-luggage-points`):
- `worker/src/types.ts`
- `worker/src/services/points.ts`
- `worker/src/services/points.test.ts`
- `docs/superpowers/plans/2026-05-21-customer-history-points-prep.md` (W3 체크리스트 업데이트)
- `docs/superpowers/plans/2026-05-21-customer-history-points-prep-worklog.md` (본 항목)

체크리스트:
- [x] W3 reserve / commit / release / earn / void mutator 추가 + idempotency key 컨벤션 노출.
- [x] points 잔액 음수 가드 (reserve는 `InsufficientPointBalanceError`, void은 `MAX(0, ...)`).
- [x] points 적립률 상수 분리 (`POINT_EARN_RATE_BPS = 100`).

실행 명령어 및 결과:
- `pnpm --dir worker test src/services/points.test.ts` -> 통과, 16 tests.
- `pnpm --dir worker test` -> 통과, 6 files / 40 tests.
- `pnpm --dir worker typecheck` -> 통과.

커밋:
- 별도 브랜치 `feature/customer-history-points-prep` 위에 본 W3 작업을 단일 커밋으로 적층 예정.

주의할 리스크:
- 본 브랜치는 `codex/phase3-experience-infra` 위의 `70e20d8`에서 분기되었으므로, phase3가 main에 머지되기 전까지는 본 브랜치도 phase3 의존성을 가진다. main에 직접 머지하려면 phase3 머지 후 rebase가 필요하다.
- 실제 customer auth handoff 미들웨어, customer route 연결, staff 결제/취소 hook 연결은 W4 이후 작업이다.
- 적립률(1%) / 사용 단위(100P) / 적립 시점(`PAID`) / 사용 시점(접수 시 예약)은 plan §4의 "승인 필요" 항목이다. 본 작업은 plan의 디폴트 값을 그대로 코드화했다.

Completed checklist items in this WORK:
- W3 entire ledger mutator set with idempotency and balance guards.

Validations passed in this state:
- Targeted points service tests, full worker test suite, and worker typecheck.

Risk points to watch in Review (if any):
- D1 `batch()`가 atomic transaction임을 전제로 했다. 운영 D1에서 batch 실패 시 부분 commit이 없다는 게 보장되는지 deploy 전에 한 번 더 확인이 필요하다.
- `reservePointUseForOrder`는 race 발생 시 (UPDATE changes != 1) 보상으로 삽입된 트랜잭션 행을 DELETE하지만, batch 자체가 rollback되었다면 DELETE 대상이 존재하지 않을 수 있다. 보상 경로는 idempotent하므로 무해.

## 2026-05-21 WORK (W7 + W8)

진행 요약:
- staff 결제/취소/일괄 처리 경로에 포인트 ledger 효과를 연결하는 `applyPointEffectsForStatusChange` 헬퍼를 `points.ts`에 추가했다.
- 4개 경로에서 헬퍼를 호출하도록 배선했다: `staffApi.ts`의 `/cancel`, `/bulk-action`, `/toggle-payment`와 `staffOrders.tsx`의 `/mark-paid`.
- 헬퍼는 status 매트릭스(PAID/CANCELLED/PAYMENT_PENDING)에 따라 commit/earn/release/void 호출을 분기하며 각 mutator의 idempotency에 의존한다.
- 매출 집계 SQL을 `admin.tsx`와 `operations.tsx`에서 통일했다. 기존 `COALESCE(NULLIF(final_amount, 0), prepaid_amount) + extra_amount` 9개 expression을 `services/orderAmounts.ts`의 `orderCollectedAmountSql()`로 교체했다.
- staff 주문 상세 페이지에 포인트 사용/적립/상태 행을 추가했다. `points_used = 0` 그리고 `points_earned = 0`이면 행 자체가 숨겨져서 guest/legacy 주문 표시는 그대로다.

최종 변경 파일 목록:
- `worker/src/services/points.ts` (헬퍼 추가)
- `worker/src/services/points.test.ts` (매트릭스 테스트 추가)
- `worker/src/routes/staffApi.ts` (3개 hook 배선)
- `worker/src/routes/staffOrders.tsx` (mark-paid hook 배선 + Order type 확장 + 포인트 행 표시)
- `worker/src/routes/admin.tsx` (매출 expression 통일)
- `worker/src/routes/operations.tsx` (매출 expression 통일)
- `docs/superpowers/plans/2026-05-21-customer-history-points-prep.md` (W7 + W8 체크리스트)
- `docs/superpowers/plans/2026-05-21-customer-history-points-prep-worklog.md` (본 항목)

체크리스트:
- [x] W7: 4개 staff status 전환 경로에 점수 hook 배선.
- [x] W7: `applyPointEffectsForStatusChange` 매트릭스 테스트 (PAID/CANCELLED/PAYMENT_PENDING + 동일 status no-op).
- [x] W8: 매출 SQL expression 9곳 통일.
- [x] W8: staff 상세 페이지 포인트 행 + guest invariant 유지 (points_used=0 && points_earned=0이면 숨김).

실행 명령어 및 결과:
- `pnpm --dir worker test` -> 통과, 6 files / 44 tests.
- `pnpm --dir worker typecheck` -> 통과.

커밋:
- 별도 커밋으로 적층 예정.

주의할 리스크:
- `applyPointEffectsForStatusChange`의 cancel 경로는 `fromStatus`를 "UNKNOWN"으로 호출한다. 헬퍼는 toStatus=CANCELLED 분기만 보므로 동작에는 영향이 없지만, 추후 fromStatus 의존 로직(예: 적립 시점 정책 변경)이 추가될 때 cancel route에서 사전 SELECT가 필요해질 수 있다.
- `staffApi.bulk-action`은 UPDATE의 statusGuard로 인해 일부 order는 status가 실제로 바뀌지 않을 수 있다. 헬퍼 호출은 모든 order에 무차별로 실행되지만 각 mutator가 reservation/earn 부재 시 noop이라 안전하다.
- staff 상세 페이지의 포인트 행은 모든 status에서 동일하게 보인다. 결제 전(`RESERVED`), 결제 후(`POSTED`), 취소(`VOIDED`) 구분은 `point_usage_status` 컬럼의 raw 값을 그대로 노출한다. 더 친절한 라벨링은 후속.
