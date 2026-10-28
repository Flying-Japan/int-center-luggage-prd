# Flying Pass 현금 환급 — 1단계 백엔드

## 사용 상태

**운영 사용 불가.** 공개 internal API의 기본 router는 `REFUND_SETTLEMENT_NOT_READY`(503)를 반환한다.
`LUGGAGE_FLYING_PASS_REFUNDS_ENABLED=true`만으로 열리지 않는다. 정산 연동 완료 후 별도 변경이 필요하다.
로컬 D1 테스트만 `createFlyingPassRefundRoutes(true)`와 `APP_ENV=test`, 위 기능 플래그를 함께 사용한다.
Wrangler 설정과 운영 환경에는 플래그를 추가/설정하지 않았다.

최초 주문 가격·등급·결제 상태와 원 수납은 변경하지 않는다. 확정 환급은 별도 기록이며, 현재 등급은 최초 등급 및 확정 환급의 `after_tier` 이력으로 해석한다.
기존 PAID `/price`, `/pricing` 제한, 직원 금액 저장 오류 수정은 유지한다.

## API 계약

모두 POST이며 기존 `/internal/*` HMAC 인증 아래에 있다. 요청마다 `actor: {userId,name,email,role}`를 보내며 Worker가 활성 직원과 권한을 재검증한다.
요청에서 `staff_id`, 환급 수단, 지급일 또는 계산된 환급액을 지정할 수 없다.

기본 경로: `/internal/luggage-orders/:orderId/flying-pass-refunds`

| 경로 | actor 이외 요청 값 | 응답 |
|---|---|---|
| `/preview` | `targetTier` | `quote`(금액·등급·이전 확정 ID·fingerprint·JST 지급일) |
| `/register` | `refundId` UUID, `targetTier`, `reason` 1~200자, `expectedFingerprint` | `refund`, `replayed`; 신규 201, 동일 요청 200 |
| `/:refundId/lookup` | 없음 | 저장 기록 및 재지급 금지 안내 |
| `/:refundId/confirm` | `cashPaid: true`, `expectedAmount` 정수 엔 | 확정 기록; 동일 확인 재요청은 기존 결과 200 |
| `/:refundId/cancel` | `confirmNotPaid: true`, `reason` 1~200자 | 미지급 취소; 동일 요청 재전송 가능 |

`PAYOUT_PENDING`은 지급 여부가 미확정인 기록이다. 발견했다고 다시 현금을 지급하면 안 된다.
지급 건을 등록한 동일 사용자·직원만 확정/취소할 수 있다. 기능 플래그를 OFF해도 로컬 테스트의 기존 기록 조회·확정·미지급 취소는 가능하다.
미지급 취소는 실제 미지급이라는 직원의 명시적 확인을 기록하는 것이며 현금 출금을 되돌리는 동작이 아니다.

확정 응답 유실 시 새 환급 ID를 만들지 말고 같은 ID로 조회/확인한다. 같은 ID에 다른 등록 내용이나 다른 최종 처리 내용을 보내면 409다.
지급일이 JST 자정을 넘으면 자동 확정하지 않는다(`PAYOUT_DAY_CHANGED`). 진행 중 기록은 자동 만료하지 않는다.
담당자 부재, 지급일 불명확 건에 대한 관리자 인계/증빙 복구는 후속 운영 절차가 필요하다.

## 검증·DB 보호

- PAID 원주문, 실제 원 수납, 정상 가격 재계산 일치, 수동 금액 없음, 정산 검토/이상 금액/미수납/미청구 연장일 없음을 확인한다.
- 원 수납은 CASH/PAY_QR 또는 그 혼합이어도 되지만 환급 기록은 JPY/CASH만 허용한다.
- `pricing.ts`의 장기 할인 후 주문당 정액 할인 및 BLACK 무료 규칙을 재사용한다. 할인 대상은 최초 기본 보관료이며 연장료는 유지한다.
- 추가 지급액 = 최초 기본료 − 기존 확정 환급 합계 − 새 등급 기본료. 0/음수 차액은 거부한다.
- 과거 결제일의 마감은 건드리지 않는다. 지급일의 FINAL_CLOSE가 있으면 등록/확정을 거부한다.
- 조회 시점과 쓰기 트랜잭션 안에서 주문·수납·재무·환급 이력을 검사하고, 확인 단계에서 금액·상태·계산 근거·지급일 마감을 다시 확인한다.
- 등록/확정/취소의 감사로그와 상태 변경은 같은 D1 batch다. 최종 SQL 검사로 RAISE(IGNORE) 같은 무변경 성공도 롤백한다.
- 부분 UNIQUE 인덱스가 주문별 진행 중 1건을 보장한다. 순번·이전 확정 기록·누적액과 감사로그 FK/내용도 검증한다.
- 확정/취소 이력은 수정·삭제할 수 없다. 원 주문·수납·참조 감사로그의 REPLACE 우회도 막는다.
- **정산 미연동 보호:** 진행 중 또는 확정 환급이 있으면 해당 주문의 상태/가격 근거 변경과 해당 지급일 FINAL_CLOSE를 차단한다.
  아직 순청구·순수납 View가 없으므로 확정 후 수령을 허용하지 않는다. 단순 기능 플래그로 이 DB 보호를 해제하지 않는다.

## 마이그레이션

`migrations/20261028_flying_pass_refunds.sql`은 신규 테이블·인덱스·트리거만 만든다. 기존 청구/매출 View를 변경하거나 주문·수납 행을 수정하지 않는다.
기존 `20261025_extension_receipts.sql`, `20261026_root_settlement_review.sql`의 청구/정산 View가 선행되어야 한다.
실행 전 실제 운영 스키마와 적용 이력을 읽기 전용으로 대조해야 한다. 이 작업에서는 운영 마이그레이션을 실행하지 않았다.
신규 스키마와 마이그레이션의 정의 일치 및 반복 적용은 회귀 테스트로 검사한다.

## 검증 명령

worker 디렉터리에서 실행:

```sh
node scripts/test.mjs
node node_modules/typescript/bin/tsc --noEmit
node scripts/check-customer-assets.mjs
node scripts/test-flying-pass-refunds-d1.local.mjs --run-local
```

마지막 명령은 같은 환급 회귀 테스트를 Miniflare/workerd의 새 임시 D1에서 실행한다.
기존 DB, Wrangler 설정, `.env`, 운영 계정 또는 원격 D1을 사용하지 않는다. 권한 확인은 합성 직원 응답으로 대체하고 나머지 외부 요청은 차단한다.
테스트는 감사 실패·무변경 쓰기·동시 등록/확정/취소·응답 유실·원장/가격 REPLACE 우회·마감/가격 경합·현금/QR/혼합·연장·수동금액·권한을 포함한다.

## 후속 정산 연동 전에는 활성화 금지

1. 확정 환급을 할인 조정 및 현금 출금으로 반영하는 청구/잔액/일별 매출 View와 DTO를 추가한다. 원 수납 총액 의미는 보존한다.
2. 환급일의 음수 현금/매출 및 환급만 있는 날짜를 보존하고, 원장/Sheets/마감의 출처 우선순위를 맞춘다.
3. 실사 시재에서 환급을 다시 빼지 않도록 현금마감 스냅샷·대조와 감사 내역을 연결한다.
4. 정상 정산된 확정 환급만 수령 가능하도록 Worker·DB·통합 어드민 검증을 함께 갱신하고 1단계 DB hold를 교체한다.
5. 정산 검토/매출/마감/UI에 원 수납·환급·순액과 현재 등급을 표시한다.
6. 관리자 복구 절차, 자정 경계, 마감 후 환급 정책 및 연동 회귀 검증을 완료한 후 공개 router의 준비 상태를 변경한다.
