# Customer History And Points Prep Work Log

## 2026-05-21 WORK (W1-W2 + W8 helper foundation)

진행 요약:
- Account `person_id`를 주문과 연결할 수 있도록 `account_person_id` 기반 nullable 스키마를 추가했다.
- 포인트 잔액 스냅샷과 포인트 거래 원장 테이블을 추가했다.
- 최근 이력 조회와 포인트 잔액 조회를 담당하는 customer context 서비스를 추가했다.
- 포인트 사용량 계산과 주문 수금액 계산 helper를 추가했다.

체크리스트:
- [x] W1: schema + migration foundation (orders nullable + 3 new tables + indexes)
- [x] W2: customer context adapter (`getCurrentCustomer`, `loadCustomerContext`, `loadRecentCustomerOrders`, `loadPointBalance`)
- [x] W8 일부: amount aggregation helper foundation (`orderCollectedAmountSql`)

## 2026-05-21 WORK 2 (W3-W7 full implementation)

진행 요약:
- 포인트 ledger의 5개 mutation helper와 status-transition orchestrator를 추가했다.
- `/customer` GET을 async로 전환하고 customer context 로드, 프로필 카드, 최근 이력 카드, 포인트 입력 UI를 인증 고객에게만 노출했다.
- `/api/price-preview`가 `points_to_use`를 받고 서버에서 잔액/금액으로 캐핑한 뒤 `final_amount`/`point_discount_amount`를 반환하도록 했다.
- `/customer/submit`이 인증 시 Account 프로필로 name/phone/email을 덮어쓰고, INSERT 전에 포인트를 RESERVE하며, INSERT 실패 시 release + R2 cleanup을 수행하도록 했다.
- staff mark-paid / cancel / bulk-action / toggle-payment 라우트가 `applyPointEffectsForStatusChange`를 통해 commit/earn/release/void을 적용하도록 hook을 걸었다.
- vitest 인프라 (`@cloudflare/vitest-pool-workers`, `vitest.config.mts`, `pnpm test` script)를 prep 브랜치에 추가했다.

체크리스트:
- [x] W3: `reservePointUseForOrder`, `commitReservedPointUseForOrder`, `releaseReservedPointUseForOrder`, `postEarnedPointsForPaidOrder`, `voidEarnedPointsForOrder`, `applyPointEffectsForStatusChange`
- [x] W4: profile summary + recent history cards + `applyRecentOrderPreset` JS
- [x] W5: point input + 전액사용 button + price-preview API points field
- [x] W6: submit flow uses profile + caps + reserves + insert + release-on-failure
- [x] W7: mark-paid, cancel, bulk-action, toggle-payment status hooks
- [x] Vitest infra (`@cloudflare/vitest-pool-workers`, `vitest.config.mts`, `pnpm test`)

실행 명령어 및 결과:
- `pnpm --dir worker typecheck` → 통과
- `pnpm --dir worker test` → 통과 (3 files / 32 tests)

커밋:
- `bc82429` feat(worker): customer history + points prep — services, migration, schema
- `ad28d2f` feat(worker): add CustomerSession + AppVariables.customer (history/points prep)
- `33bd630` chore(worker): add vitest infra for prep tests
- `c0597c7` feat(worker): customer history + points UI/submit + ledger mutation helpers
- `8c93a95` feat(worker): wire point ledger effects into staff status transitions

PR: https://github.com/Flying-Japan/int-center-luggage-prd/pull/6

주의할 리스크:
- live 코드가 새 컬럼을 참조하기 시작했으므로 **이 PR이 머지되기 전에** `worker/migrations/20260521_customer_history_points_prep.sql`을 D1에 적용해야 한다.
- 로그인 미들웨어가 `c.set("customer", session)`을 세팅하기 전까지 인증 path는 비활성. guest path는 그대로 동작.
- admin/operations 매출 SQL을 `orderCollectedAmountSql`로 교체하는 작업은 phase 3 PR에서 별도 진행 중. 머지 순서 dependency 주의.

남은 작업 (이 PR scope 밖):
- 로그인 / 회원가입 UI + middleware
- 고객 마이페이지 + 포인트 상세 내역
- 운영자용 포인트 수동 조정 UI
- admin.tsx / operations.tsx의 매출 expression이 `orderCollectedAmountSql`을 채택 (phase 3 PR)
