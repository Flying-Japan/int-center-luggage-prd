# 자동 추가 보관료 운영 배포 결과 — 2026-10-28

- 최종 확인: 2026-10-28 05:42 JST (09:00 영업 시작 전)
- 코드 구현 / 운영 배포 / 자동 생성 활성화: 모두 완료
- Worker: `int-center-luggage-api`, version `12f7db11-0a94-4784-955c-b51476493671`, traffic 100%
- Source commits: `03accbd3bf7224903d677e4ef2b3d81555963a05`, `df250cc3bfa1f859e60d3e150ae4ea5261c08a0b`
- 배포된 기존 F1 기준 소스 보존: `c896f4291603bd4213eb71329ddd4f0452ae090e`
- Branch: `codex/luggage-21-auto-fees` (push 완료, main 및 원본 worktree 변경 없음)

## 결과

21:00 Asia/Tokyo 경과 시 일 요금이 누적되고 자정에는 중복 부과되지 않는다.
기존 저장 일 요금과 기존 초과일 할인 정책을 유지한다. 최초 수납 또는 서버의
결제확정 감사 기록 이전의 밤은 미확인 보관 기간으로 보고 자동 청구하지 않는다.
03:00 Cron은 같은 미청구 날짜를 연장 주문으로 전환하므로 합계는 증가하지 않는다.
반복 실행은 0건, 실행 누락은 확인된 보관일의 미생성 날짜를 따라잡는다.

기존 운영 주문은 컷오버 `2026-10-27T20:24:58.653Z` 이전 접수이므로 새 자동 부과에서
제외했다. 보관 상태를 별도로 확인할 활성 원주문은 2건이며, 그중 결제대기 1건의
가상 추가요금 ¥2,400을 청구하지 않았다. 해당 기존 미수납 ¥4,800 및 별도 정산
검토는 유지했다. 기존 주문에 대한 새 자동 청구 예상: **0건 / ¥0**.

자동 생성 설정은 실제 활성 상태다. 기존 바인딩 26개 및 Secret/D1/R2/Route를
보존하고 활성화 변수 1개만 추가했다(총 27개). Cron `0 15 * * *`, `0 18 * * *`와
preview URL 차단을 유지했다. GitHub Actions는 disabled_manually이며 Cloudflare
Builds는 미연결 상태를 유지했다.

## DB / 검증

적용한 forward migrations:

1. `20261028_close_time_extension.sql`: 21시 계산 및 신규 적용 시작점
2. `20261028_confirmed_intake_extension.sql`: 수납 확인 전 소급 계산 방지

- 신규 운영 SQL 백업 각각 로컬 복원, integrity / foreign-key 검사 통과
- 실제 Wrangler local import 성공 및 의도적 실패의 전체 DDL rollback 통과
- 로컬 복원/마이그레이션에서 원본 29개 및 보완 시점 30개 테이블의 기존 모든 값 불변
- 전체 주문군 재무 요약·정산 검토 불변, 운영 수납 원장 12,283행 해시 일치
- F0 / F1 전체 테스트 각각 202/202, 타입·고객 자산 guard 통과
- 실제 로컬 workerd D1 HTTP 검증 21/21
- 운영 signed GET 100/500건 재무 대조 및 unsigned 401 검증 통과
- 검증 artifact와 실제 최종 운영 코드의 SHA-256 일치

Unified Admin `b3d5d00a-f51e-49a3-a79a-a98efd7abf96`는 재배포하지 않았다.
기존 `outstanding_amount` / `extension_outstanding_amount` 계약으로 표시한다.
원주문의 기존 `extra_amount`에 연장 주문을 중복 합산하지 않는다.

## 변경 파일

- `worker/src/services/luggageBilling.ts`
- `worker/src/schema.sql`
- `worker/migrations/20261028_close_time_extension.sql`
- `worker/migrations/20261028_confirmed_intake_extension.sql`
- `worker/tests/luggageBilling.test.ts`
- `worker/scripts/verify-d1-http.local.mjs`
- `worker/docs/automatic-extension-release.md`
- 이 운영 결과 문서

## 남은 확인

실제 Cron 생성은 아직 0건이다. 다음 생성 시각은 **2026-10-29 03:00 JST**이며,
실행 성공을 시뮬레이션 성공으로 대체하지 않았다. 운영 테스트 주문·수납·수령 요청은
만들지 않았다. 기존 제외 2건의 실제 보관 여부와 과거 정산은 직원이 따로 확인한다.
위험 때문에 중단된 미완료 배포 작업은 없다.

원본 F1 후보 38개 파일은 변경하지 않았다. 검증된 SQL 백업과 제외 주문 목록은
사용자 홈의 owner-only 비공개 보관소에 보존했다. 위치와 검증 JSON은 이번 작업의
로컬 비공개 릴리스 기록에서 확인할 수 있다. 고객 데이터·인증정보·환경변수 값은
Git에 포함하지 않았다.
