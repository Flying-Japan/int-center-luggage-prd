# Flying Pass 환급 2단계 — 청구·수납·마감·매출·수령

## 범위와 활성화 상태

1단계의 원 수납·최초 가격·등급·결제 상태 및 환급 이력을 보존한 상태에서 정산을 연결했다.
정상 수령에 따른 PAID → PICKED_UP 전환은 허용하지만 결제 대기 복구, 수납 삭제, 최초 가격 수정은 허용하지 않는다.
1단계 마이그레이션 및 기존 직원 금액 저장 오류 수정본은 변경하지 않았다.

**공개 환급 API는 여전히 잠겨 있다.** `LUGGAGE_FLYING_PASS_REFUNDS_ENABLED`는 기본 OFF이며 환경 설정을 변경하지 않았다.
3단계 UI·운영 검증 전에는 플래그만 켜도 동작하지 않는다. 테스트만 기존의 명시적인 로컬 테스트 router를 사용한다.

## 데이터 구조와 계산

신규 마이그레이션: `migrations/20261028_flying_pass_refund_settlement.sql`
선행 조건: 기존 연장/수납/원주문 정산 View 및 1단계 환급 마이그레이션.

- `luggage_orders`의 금액·최초 등급과 `luggage_order_payments`는 원본 그대로 유지한다.
- 확정된 CASH 환급만 할인 조정액 및 현금 출금으로 반영한다. 진행 중/취소 건은 금액 집계에서 제외한다.
- `luggage_billing_lines`, `luggage_billing_balances`에 실효 청구·순수납·진행 중 건수·현재 적용 등급과 환급 ID를 추가한다.
- `luggage_sales_daily`는 지급일 JST 기준으로 원 현금 수납에서 확정 환급을 한 번 뺀다. 원 QR 수납은 보존한다.
- `luggage_receipt_sales`는 양수 원 수납 원천으로 그대로 유지한다.

```text
실효 청구 = 기존 총 청구 − 확정 할인 조정
순수납    = 실제 원 수납 − 확정 현금 환급
잔액      = 실효 청구 − 순수납 − 기존 legacy 추정액
```

legacy 추정액을 새로운 실제 수납으로 바꾸거나 기존 정산 이상을 환급으로 면제하지 않는다.
연장 청구·미청구 연장일은 기존 규칙대로 합산한다. 원주문 환급을 연장 미수납과 상계하지 않는다.

### Worker billing 응답 계약

기존 필드 의미는 유지한다: `total_billed_amount`는 최초 청구 + 연장/미청구분, `recorded_amount`는 실제 원 수납 총액이다.
다음 필드를 함께 반환한다.

| 필드 | 의미 |
|---|---|
| `refund_settlement_version: 2` | 2단계 응답 버전 |
| `discount_credit_amount` | 확정 할인 조정 합계 |
| `cash_refunded_amount` | 확정 현금 지급 합계 |
| `total_effective_billed_amount` | 조정 후 청구 합계 |
| `net_received_amount` | 원 수납에서 현금 지급을 뺀 순수납 |
| `pending_refund_count`, `refund_count` | 진행 중/확정 건수 |
| `effective_flying_pass_tier` | 최신 확정 환급을 반영한 원주문 등급 |
| `pending_refund_id` | 진행 중 지급 건 ID, 없으면 null |
| `latest_confirmed_refund_id` | 최신 확정 ID, 없으면 null |

통합 어드민은 구버전 응답과 호환되지만 v2 필드 일부 누락·잔액 보존식 모순·불완전한 ID를 정상 금액으로 보정하지 않고 재무 정보 오류로 처리한다.
진행 중 건은 `REFUND_PENDING`으로 수령·결제 토글을 막고 재지급 금지 메시지를 표시할 수 있도록 전달한다.

## 수령과 동시성

- 정상 확정 환급 + 미수납 없음 + 정산 이상 없음이면 기존 공통 수령 서비스로 수령할 수 있다.
- 진행 중 지급, 연장 미수납, 기존 원주문 검토/비정상 금액 차단은 유지한다.
- 수령 직전 D1 batch와 DB 트리거에서 진행 중 건을 다시 확인한다. 클라이언트에서 버튼을 강제로 호출해도 우회할 수 없다.
- 환급 등록/확정/취소에 따라 직원·통합 어드민 dashboard sync token이 바뀐다. 원주문 updated_at은 이를 위해 다시 쓰지 않는다.

## 현금마감

새 `luggage_cash_closing_refund_snapshots`는 환급일 최종 마감의 원 현금/QR·환급 합계·환급 ID 목록·순현금/순매출을 불변 기록으로 보존한다.
환급이 있는 날에만 sidecar와 `REFUND_SNAPSHOT` 감사로그가 자동 생성된다.

- 기존 실사 공식 `(현금 시재 − 준비금 40,000) + 실제 QR`은 유지한다. 여기서 환급을 다시 빼지 않는다.
- 진행 중 지급이 있으면 FINAL_CLOSE를 거부한다.
- 사전 계산 이후 환급이 확정돼 자동 매출/QR 기준이 달라졌으면 `REFUND_CLOSING_CONFLICT`(409)로 마감을 거부한다.
- 마감이 먼저 확정됐으면 이후 환급 등록/확정이 차단된다.
- 스냅샷·감사 생성 실패와 RAISE(IGNORE)도 전체 마감 트랜잭션을 롤백한다.
- 재실사 수정은 가능하지만 기존 환급 기준 스냅샷을 바꾸거나 마감일을 옮길 수 없다. 감사 실패 시 수정도 롤백한다.
- 기존 마감 INSERT/수정, 새 sidecar, 참조 감사의 삭제/REPLACE 우회를 차단한다.

마감 조회는 `refundSnapshot`을 제공한다: `grossCashAmount`, `grossQrAmount`, `cashRefundAmount`, `refundCount`, `refundIds`, `netCashAmount`, `netTotalAmount`.
환급 마감 조회의 자동매출/차액은 현재 자료를 다시 섞지 않고 이 고정 기준으로 계산한다.

## 매출·Google Sheets

결제일이 과거라면 그 결제와 마감은 보존하고 지급일에만 출금을 기록한다.
환급만 발생한 날짜를 포함하고 음수 현금/순매출을 0으로 자르지 않는다.
환급이 있는 과거 마감일의 매출은 고정된 원장 순액 스냅샷을 사용하며, 실사 차액은 별도 `closingDifferenceAmount` 및 마감 상세의 차액으로 남긴다. 재실사 오차를 매출 변경으로 섞지 않고 실제 시재에서 환급을 다시 빼지 않는다.
정상 과거 비환급 마감의 기존 해석은 유지한다.

Google Sheets → `luggage_daily_sales` 동기화는 그대로다. 환급이 있는 날짜는 D1 지급 원장을 반영한 실시간 집계를 우선해 시트 가져오기가 음수 날짜를 덮지 않도록 한다.
매출 원천은 일별/요약에 `grossCash`, `grossQr`, `cashRefundAmount`, `refundCount`를 전달한다. 순현금·순매출은 기존 `cash`, `luggage` 필드다.
현금/QR 비율은 원 수납 기준이며 음수 날짜를 평균/최솟값에서 제외하지 않는다. 통합 어드민의 정규화·기간 집계도 음수를 보존한다.

## 검증 및 운영 적용 금지

worker 디렉터리:

```sh
node scripts/test.mjs
node node_modules/typescript/bin/tsc --noEmit
node scripts/check-customer-assets.mjs
node scripts/test-flying-pass-refunds-d1.local.mjs --run-local
node scripts/verify-d1-pickup.local.mjs --run-local
```

로컬 D1 검증은 합성 데이터 및 매번 새 Miniflare/workerd D1만 사용하고 외부 요청을 차단한다.
검증 결과: Worker 270개, 통합 어드민 510개, 환급 로컬 D1 45개, 기존 수령 D1 7개 및 part_time 권한 D1 10개 통과. 양쪽 타입 검사와 고객 자산 검사도 통과했다. 실제 직원·고객 브라우저 E2E 및 현장 시재 대조는 수행하지 않았다.
통합 어드민은 `node --test tests/*.test.mjs`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`로 검증한다.

테스트는 현금/QR/혼합, 과거 결제일 마감 보존, 지급일 음수 매출, 시트 덮어쓰기 방지, 과거 마감 원천 선택, 수령/연장 미수납, 마감/환급 경합, 감사 오류·IGNORE, 재실사, 스냅샷 불변성, 응답 유실 재조회 및 기존 1단계 형식 기록의 실제 마이그레이션을 포함한다.
운영 DB 마이그레이션·push·배포·플래그 활성화는 수행하지 않았다.
운영 적용 전에는 기존 마감의 `rental_cash`/`wand_refund` 등 선행 스키마·적용 이력도 읽기 전용으로 대조해야 한다.

## 3단계 UI에 남은 일

1. 공개 router 잠금은 별도 검토 후 해제하되 기능 플래그 기본 OFF와 기존 권한 검증을 유지한다.
2. 기존 POST 경로 `/internal/luggage-orders/:orderId/flying-pass-refunds/{preview,register,:refundId/lookup,:refundId/confirm,:refundId/cancel}`를 통합 어드민의 서명 서버 경로에 연결한다.
3. 원 청구/원 수납과 실효 청구/현금 지급/순수납을 구분해 보여준다. 기존 가격 편집기에서 PAID 금액 변경을 허용하지 않는다.
4. `pending_refund_id`가 있으면 해당 건 조회부터 한다. 새로운 지급을 안내하거나 자동 만료·취소하지 않는다.
5. 같은 ID와 등록 내용으로 재시도하고, 확정 응답 유실 시 조회 후 확정 상태를 확인한다. 실제 현금 지급 확인과 미지급 확인을 별도 동작으로 둔다.
6. 환급 ID 목록과 마감 스냅샷 대조, 음수 매출 표시 및 원 수납 기준 구성비 문구를 연결한다.
7. 담당자 인계, 자정 경과/지급일 불명확 복구 및 마감 후 지급 정책은 관리자 증빙 절차가 필요하다. 현재 자동 복구하지 않는다.
