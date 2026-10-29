# 087 정상 장기보관 할인 정정

승인 범위는 `20261023-087` 한 건이다. 정상 기본 보관료 ¥9,000에서 9일 장기보관 5% 할인 ¥450을 적용한 청구액은 ¥8,550이며 실제 현금 원장도 ¥8,550이다. 결제 다음 날의 `UPDATE_PRICE` #54341 이후 원천 청구/수동 지정액 ¥9,000이 남아 있다. 수납이나 환급으로 ¥450을 메우지 않는다.

## 릴리스 범위

- 운영 F1 소스 `36a722eff52c465062f7f984aa1fe3b74fcfccda`, Worker `e7b5bc2f-b3a7-41e1-ba76-eb1e4fb9d06b`에서 분기했다.
- 통합어드민은 기존 `3592c2b` / `2fbaa7da-c22a-4a97-88f4-71ac930353c7`을 유지한다.
- 이번 배포 단위는 D1 정정 정책과 단일 감사 이벤트이다. Worker 실행 코드, 라우트, 권한, 설정, 환급 flag, 21시 자동 연장료를 바꾸거나 재배포하지 않는다.
- 기존 미병합 환급/알바생 권한 브랜치를 포함하지 않는다. 별도의 `codex/087-approved-discount-correction` 브랜치에 보존한다.

## 정정 정책

`20261029_087_discount_correction.sql`은 수납 후 가격 보호를 명시적인 승인 정정 정책으로 확장한다. 보호를 전체 비활성화하지 않는다. 정정 이벤트 없이 직접 UPDATE하는 경로는 계속 실패한다.

`luggage_order_price_corrections`는 승인 ID와 주문 ID를 고정한다. 현재 청구·할인·수동 지정액·기간·짐 수량·리비전, 결제 원장 #12067, 결제 감사 #53907, 가격 변경 감사 #54341, 수납·미수납·연장·환급 상태를 DB 트리거가 독립 검증한다. CLI는 운영의 포인트/쿠폰 필드도 같은 트랜잭션 안에서 검증한다. 기간이 지나거나 상태/원장이 달라지면 실패한다.

이벤트 INSERT가 같은 트랜잭션에서 `CORRECT_COLLECTED_PRICE` 감사를 추가하고 `prepaid_amount`/`final_amount`를 9000→8550, `staff_prepaid_override_amount`를 9000→NULL로 바꾼다. `discount_rate=0.05`와 수납은 유지한다. 재무 View의 청구=수납=8550, 정산 검토=미수납=픽업 차단=0이라는 사후 조건이 실패하면 모두 롤백한다. 실제 수령 상태는 변경하지 않는다.

새 정정 이벤트와 기존/신규 087 감사, 원래 수납은 UPDATE/DELETE/REPLACE를 차단한다. 다른 주문에 대한 정정은 DB CHECK와 트리거가 거절하고 같은 이벤트를 재사용할 수 없다. 새 수납·환급·마감 기록은 만들지 않는다.

## 운영자 절차

일반 직원·통합어드민 API에는 정정 기능을 노출하지 않는다. 승인된 Cloudflare 운영자가 D1 Write 및 배포 메타데이터 조회 권한으로 CLI만 실행한다. 자격 증명은 기존 안전한 인증 경로로 `CLOUDFLARE_API_TOKEN` 환경에 전달하고 출력하지 않는다.

기본 모드는 SELECT만 실행한다. 새 비공개 증거 폴더를 지정한다.

```sh
node scripts/correct-087-discount.mjs --operator AUTHORIZED_OPERATOR_REFERENCE --evidence-dir /PRIVATE/NEW/READONLY_DIR
```

로컬 F1/D1 테스트와 격리 Cloudflare D1 프리뷰를 통과한 동일 SQL만 사용한다. 적용은 명시적 옵션이 필요하다.

```sh
node scripts/correct-087-discount.mjs --apply-approved-087 --operator AUTHORIZED_OPERATOR_REFERENCE --evidence-dir /PRIVATE/NEW/APPLY_DIR
```

CLI는 운영 버전, 배포 비율, 기존 재무 View/트리거를 확인하고 44건 마감·원장·다른 주문 금전 필드·정산 검토·087 감사를 저장한다. BEFORE 증거의 SHA-256과 실행 도구/정책 SHA-256을 감사와 연결한다. **정책 DDL과 정정 이벤트는 단일 D1 REST 배치**로 실행한다. 보호 트리거 교체 중 다른 요청에 노출되는 공백은 없다. 사후 스냅샷으로 다른 주문, 기존 원장/감사, 마감/마감 감사/환급 스냅샷 및 일별 매출의 불변을 검증한다. 증거 파일은 0600, 폴더는 0700이며 고객 개인정보를 로그에 출력하지 않는다.

네트워크 오류 후 쓰기를 자동 재시도하지 않는다. 다음 SELECT와 원장/재무 View로 실제 결과부터 확인한다. 승인 ID나 주문 ID를 바꿔 재시도하지 않는다.

```sql
SELECT correction_id,order_id,approval_reference,operator_reference,evidence_sha256,created_at
FROM luggage_order_price_corrections;
SELECT log_id,action,timestamp FROM luggage_audit_logs
WHERE order_id='20261023-087' AND action='CORRECT_COLLECTED_PRICE';
SELECT root_id,total_billed_amount,recorded_amount,root_review_amount,outstanding_amount,review_pickup_blocked
FROM luggage_billing_balances WHERE root_id='20261023-087';
```

적용 완료 후 DB를 임의로 되돌리거나 증거를 삭제하지 않는다. 예상과 다른 결과가 있으면 추가 금전 변경을 중단하고 저장한 증거부터 조사한다.

## 검증

- Node 22 전체 회귀 261개 통과, TypeScript 검사 통과.
- 로컬 F1 실제 HMAC 주문 API/직원 상세 화면/픽업 API로 청구·수납·픽업 판단을 확인했다. 실제 픽업 변경은 격리 로컬 DB에만 수행했다.
- 실제 Cloudflare의 신규 임시 D1에서 동일 REST 배치를 검증했다. 정정 뒤 강제 실패해도 DDL·가격·이벤트·감사가 전부 롤백되고, 포인트 상태 변동·직접 가격 수정·다른 주문 수정·수납 삭제·재실행이 차단됐다. 임시 DB는 삭제했다.
- 44건 마감과 기존 감사·수납의 불변, 다른 정산 검토 유지, 실제 연장료 발생 시 픽업 차단도 회귀 테스트에 포함한다.

## 운영 적용 결과 — 2026-10-29 16:43:37 JST

구현 커밋 `eaf609b8347d258030982698134d9c63c4b1f6f8`의 정책/정정 배치를 적용했다. 정정 ID는 `087-long-stay-discount-20261029`, 새 감사는 **#56034 / CORRECT_COLLECTED_PRICE**이다. 청구/사전금은 ¥9,000→¥8,550, 수동 지정액은 ¥9,000→NULL이며 할인율 5%와 현금 수납 #12067의 ¥8,550은 그대로다. 정산 검토 ¥0, 실제 미수납 ¥0, 미청구 연장료 ¥0, 재무상 픽업 차단 0을 확인했다. 실제 수령 상태는 PAID로 유지했다.

적용 전후 전체 비교에서 다른 주문 27,327건의 금전 필드, 수납 원장 12,447건, 다른 정산 검토 387건, 마감 44건과 해당 감사 168건, 기존 087 감사, 일별 매출 및 환급 관련 원장/스냅샷이 동일했다. 기존 마감 44건의 금전 필드는 앞선 통합어드민 릴리스 시점과도 동일했다.

운영 Worker의 실제 응답과 통합어드민 `3592c2b`의 원천 어댑터/가격 컴포넌트를 검증했다. 기본료 ¥9,000·장기 할인 −¥450·청구 ¥8,550·수납 ¥8,550·차액 ¥0으로 렌더링되며, 재무상 픽업 차단 없음과 저장 청구액/할인 계산 일치를 확인했다. 실제 수령 처리나 추가 수납 요청은 운영에 보내지 않았다.

Worker는 `e7b5bc2f-b3a7-41e1-ba76-eb1e4fb9d06b`, 통합어드민은 `2fbaa7da-c22a-4a97-88f4-71ac930353c7`을 유지한다. 두 Worker의 전체 변수와 secret 바인딩 이름/타입이 적용 전후 동일하다. 원래 통합어드민/짐보관/환급 개발 checkout도 파일 해시 및 Git 상태가 동일하다.

- 정책 SHA-256: `6b58914fb3c08e12f4031f97373db5fe2ba0be468f5dc90893467b46b977313d`
- 감사에 연결된 적용 전 증거 SHA-256: `25005a745fe2916e019714aa73b58a2988e9f03cc96d72efc5029c280c022154`
