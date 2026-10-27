# Finance F0/F1 전환 Runbook — 실행 승인 전

작성: 2026-10-28. 이 문서는 실행 절차이며 이번 작업에서 운영 명령을 실행하지 않았다.
**로컬 후보 검증 GO / 운영 전환 NO-GO.** 아래 P0가 모두 해소되고 담당자가 승인하기 전에는 M0 적용·업로드·DB 변경도 시작하지 않는다.

## 1. 고정 후보와 검증 증거

- 독립 worktree: `/Users/yunseoyun/flying/repos-latest/int-center-luggage-finance-f0-f1`
- HEAD: `aba7288c3fc597f7b4ea45bf33a74a43278b8de2` (detached, 미커밋 후보)
- 기존 재무 개발 및 M0 worktree에는 이 작업에서 쓰기 작업을 하지 않았다. 종료 검사에서 개발 원본 5개 파일의 변경을 관측했고, 재무 관련 2개 라우트와 테스트만 후보에 추가 반영했다. 파트타임 관련 2개 파일은 반영하지 않았다. 시작/관측/종료 해시는 manifest에 기록하며, M0는 모든 기록 파일 해시가 그대로다. 배포 직전 후보 소스 동결과 해시 재대조가 필요하다.
- Wrangler 4.73.0, Node 26.6.0, TypeScript 5.9.3. 패키지/lock 파일은 운영 기준 그대로다.
- F0 설정: `worker/wrangler.toml`, entry `src/index.f0.ts`.
- F1 설정: `worker/wrangler.f1.toml`, entry `src/index.tsx`.
- 둘 다 `preview_urls = false`. 기본 설정으로는 F0만 빌드된다. HTTP·세션·HMAC·환경변수로 모드를 바꿀 수 없다.
- M0의 `maintenance.ts`를 바이트 그대로 재사용한다. F0의 차단 응답은 M0와 같은 503/MAINTENANCE/no-store이며 health는 F0를 명시한다.
- F0는 health와 HMAC 인증된 GET 다섯 종류만 허용한다: `/internal/luggage-orders`, `/internal/luggage-orders/dashboard-sync`, `/internal/luggage-sales-analytics`, `/internal/luggage-sales-heatmap`, `/internal/luggage-cash-closings`.
- 고객·직원 화면·이미지·OAuth·나머지 GET 및 모든 변경 요청은 503. cron은 작업 함수/waitUntil을 시작하지 않는다. 진행 중인 기존 작업을 취소하지는 않는다.
- F0 D1 capability는 SELECT/WITH 조회만 허용하고 run/batch/exec/session/DDL/DML을 차단한다. R2 접근 및 background 등록도 차단한다. 기존 프로필 확인용 Supabase GET은 허용될 수 있다. 이 GET의 운영 측 부수효과 없음은 연동 담당자 확인 대상이다.
- F1은 재무·수납·픽업·조회 개선이 포함된 정상 Worker다. 파트타임 actor 역할/테이블/마이그레이션/프로필 upsert는 포함하지 않는다. 원장/정산 정책은 기존 검증 구현 그대로다.

최종 로컬 출력:

```text
/private/tmp/flying-luggage-finance-release-k3uytmos/final-manifest.json
/private/var/folders/nk/jn0bzpjs1x78b_56_dx4n89h0000gn/T/flying-finance-release-XeOZGX/report.json
/private/var/folders/nk/jn0bzpjs1x78b_56_dx4n89h0000gn/T/flying-finance-rehearsal-w42dppg3/report.json
```

운영자는 임시 산출물을 접근 제한된 승인 보관소에 복사하고 manifest와 SHA-256을 다시 대조한다. 임시 경로가 사라지면 미검증 번들로 대체하지 말고 로컬 재검증한다. 복제 DB와 SQL 백업은 개인정보가 포함될 수 있으므로 배포 번들/공개 저장소에 넣지 않는다.


최종 배포 번들 SHA-256 (prebuilt):

| 후보 | SHA-256 |
|---|---|
| F0 | `53194719af3e6cb524c0bfe596a7e6755ccd5c4e4ddf012476068434d4603ad4` |
| F1 | `af41a9ff652f9b37d46fbeb81da986adcbda8ff18e7ee1278948f1b6ee0dde9b` |

## 2. 사전 승인표 — 모두 미완료 상태

| 책임자 | 필수 확인 및 기록 | 중단 조건 |
|---|---|---|
| 변경 책임자 | 유지보수 창, 사용자 안내, M0/F0/F1 해시, 중단/복구 결정권자 지정 | 승인자/시간/대체 담당자 없음 |
| Cloudflare 관리자 | 계정/D1/Worker/라우트/cron/바인딩 재확인, Version/alias URL 차단, 새 Previews 및 우회 binding 통제 | 하나라도 미확인 |
| CI 담당자 | GitHub Actions 및 Cloudflare Builds 각각 신규 실행 차단과 실행 중 작업 종료 증거 | 어느 한쪽만 중단, upload 작업 잔존 |
| DB 담당자 | 최신 정지 시점 SQL 백업·bookmark·해시·복구 권한/유효 기간·복제 리허설 승인 | 오래된 보유 백업만 존재 |
| 현장 책임자 | 수납/픽업/접수의 성공·실패·상태 불명 전수 분류 | 상태 불명 한 건 이상 |
| 연동 담당자 | Python/R2/Reviewer/Unified Admin/수동 스크립트/외부 비동기 작업 통제 | 실행 여부·큐 상태 불명 |
| 재무 책임자 | 정산 검토 정책 유지와 활성 ¥450 인도 차단의 업무 대책 승인 | 자동 면제/추가 수납/무근거 승인 요구 |

현재 배포 버전/바인딩은 이번 작업에서 원격 재조회하지 않았다. 과거 확인한 `cee5acf9-b246-4207-8e30-0ff7d70382bd`가 여전히 100%인지 반드시 적용 직전 확인한다. 다르면 중단하고 차이를 분석한다.

## 3. 우회 경로와 Writer 동결

1. **업로드 전에** Cloudflare Dashboard의 해당 Worker > Settings > Domains & Routes > Version URLs를 비활성화하고 메타데이터와 변경 이력을 보관한다. Version URLs 비활성화는 기존 version 및 alias routing을 차단한다. 기존 업무 버전 URL에 시험 HTTP GET을 보내지 않는다.
2. F0/F1의 `preview_urls=false`가 후속 배포에서도 유지되는지 확인한다. 이 설정은 production workers.dev와 `luggage.flyingjp.com/*`를 차단하지 않는다. 그 경로는 활성 M0/F0가 차단한다. 별도 Workers Previews/Build preview Worker/Pages preview/다른 service binding은 독립 점검한다. Version URL 차단을 모든 preview 차단으로 간주하지 않는다.
3. GitHub Actions의 `deploy-worker.yml`: main의 worker/** push 및 workflow_dispatch를 통제한다. 실제 running/queued 상태와 수동 실행 권한을 확인하고 신규 실행 중단을 승인받는다. deploy 이후 R2 static 업로드도 범위에 포함한다. 이번 후보에서 workflow는 수정하지 않았다.
4. Cloudflare Workers Builds: production main과 비운영 branch builds, deploy/version upload hook, 수동 build를 별도로 통제한다. Actions 중지만으로 완료하지 않는다. `versions upload`로 교체하는 것은 freeze가 아니다. 재연결/설정 자동 복구·watchdog·권한 보유자의 수동 실행도 통제한다.
5. 아래 표를 현장에서 채우고 로그/큐 내역의 위치와 확인 시각을 기록한다.

| Writer | 정지/확인 범위 | 재개 조건 |
|---|---|---|
| Python R2 업로드/삭제/정리 및 Supabase 동기화 | 프로세스·스케줄러·재시작 watchdog·startup backfill·연장 catch-up 모두 정지 증빙 | R2/DB 차이 대조 후 작업별 승인 |
| Reviewer | producer·consumer·5분 cron·수동 재시도 모두 정지, PENDING/PROCESSING/FAILED/DEAD_LETTER 및 lease/외부 ID 보존 | 성공 여부 불명 작업을 먼저 원장/주문과 대조, 순차 승인 재시도 |
| Unified Admin | Luggage mutation flag/호출 주체 차단, 읽기 조회는 F0 allowlist와 실제 계약 확인 | 신규 billing 정상화/409 유형별 처리/위험 결제 토글 비활성화 확인 |
| 직접 D1/R2 CLI/API·백필·수동 작업 | 토큰 보유자/실행 호스트/예약 작업 책임자 확인, 신규 실행 동결 | 변경 책임자 서명 후 제한적으로 재개 |
| 다른 Worker/Pages/service binding | 동일 D1 ID와 R2 bucket의 모든 환경 및 과거 버전 연결 조사 | 알 수 없는 Writer 없음 |
| cron/waitUntil | M0/F0는 새 실행을 막음. 이전 버전 실행은 개별 로그/부수효과 확인 | 기존 작업 모두 종결, F1 첫 cron 시간 별도 승인 |
| Supabase/Brevo/Asana | 이미 수락된 요청·웹훅·재시도·메일/태스크를 외부 서비스 담당자와 대조 | 중복 발송/등록 방지 및 미완료 처리 계획 승인 |

Reviewer의 503 재시도는 유지보수 해제 직후 한꺼번에 재생시키지 않는다. 큐 삭제·attempt 초기화·실패를 성공으로 변경하지 않는다. 기존 정책의 1/10/60분 재시도 및 lease만으로 안전한 정지를 보장할 수 없다. 현재 구현에 필요한 pause/선별 재개 기능이 없으면 별도 구현/운영 통제 승인 전 NO-GO다.

## 4. 진행 작업 종료 판정

전역 진행 작업 등록부가 없으므로 단순 대기, 주문 수 고정, bookmark 동일은 종료 증거가 아니다. 각 요청/작업을 성공·실패·상태 불명으로 분류한다.

- 수납: 요청 ID/주문 ID, 현장 실제 수납 증빙, immutable 원장 및 감사 이벤트를 대조한다. 응답 불명 상태로 새 수납 ID를 만들어 재요청하지 않는다.
- 픽업/취소: 원주문/연장 주문 상태·실제 인도 시각·감사 기록·현장 인도 여부를 대조한다.
- 접수/R2: 요청·주문·객체 key·완료 로그를 대조한다. 임의 삭제/재업로드하지 않는다.
- cron: 실행 ID·시작/완료 로그·D1 변경과 외부 알림 결과를 연계한다. 로그 부재를 미실행으로 간주하지 않는다.
- Reviewer: processing lease 만료만으로 실패를 확정하지 않는다. 원격 주문과 기존 receipt/request ID를 대조한다.

한 항목이라도 종결을 증명할 수 없으면 M0 유지 상태에서 **DB 마이그레이션 진입 NO-GO**. 관측 장치 추가나 수동 대조 절차의 별도 승인이 필요하다. 이번 로컬 구현은 이 문제를 해결하지 않는다.

## 5. 대상 구성과 보존 위험

| 항목 | 고정 기대값 |
|---|---|
| Account | `6efe0c5d58f6e8bb28165c599fa36c33` |
| Worker | `int-center-luggage-api` |
| D1 | `DB` / `center-luggage-db` / `dfae11bb-0dd9-4e7c-be27-d6e98c7c3b77` |
| R2 | `IMAGES` / `luggage-images` |
| Route | `luggage.flyingjp.com/*`, zone `flyingjp.com` |
| Compatibility | `2025-04-01`, `nodejs_compat` |
| workers.dev | true (실제 hostname은 직전 메타데이터 재확인) |
| Version URLs | false 필수 |
| cron | `0 15 * * *` / `0 18 * * *` (00:00 / 03:00 JST) |

배포 명령은 항상 `--keep-vars`를 명시한다. 단, config에 명시된 APP_ENV=production/BUSINESS_OPEN_HOUR=9/BUSINESS_CLOSE_HOUR=21은 명시값이므로 현재 운영과 다르면 중단한다. 대시보드의 나머지 변수를 보존하고 AUTO_EXTENSION_ENABLED의 실제 값은 추정·활성화하지 않는다. Secret 이름/바인딩 타입만 대조하고 값을 조회·로그·재생성하지 않는다. 이번 검증은 깨끗한 HOME/env 및 dotenv 없음으로 패키징했고 알려진 credential 형식도 검사했지만, 실제 Secret 값과의 비교는 수행하지 않았다.

이름/라우트/cron이 같다는 로컬 검사는 실제 계정 상태를 증명하지 않는다. 다른 바인딩·routes·vars가 운영에 추가되어 있으면 그대로 덮어쓰기 전에 보존 계획을 승인받는다.

## 6. 적용 순서 (이번에는 실행하지 않음)

0. 승인표, Writer 동결, Version/alias/Preview 통제, CI 두 경로 통제, artifact SHA 확인. 기본 config가 F0인지 재확인. 현재 운영 소스 SHA/트래픽이 다르면 중단.
1. 승인된 **기존 독립 M0 artifact**를 100% 적용한다. 새/옛 버전을 혼합하는 점진 배포는 금지. production custom domain/workers.dev/service binding 등 모든 경로의 차단 상태와 cron skip을 확인한다. 이 적용은 별도 운영 승인 작업이다.
2. 진행 작업 전수 종결 및 외부 큐 정지를 증명한다. 불명 항목이 있으면 다음 단계로 진행하지 않는다.
3. DB 담당자가 정지 시점의 최신 SQL export와 Time Travel bookmark를 확보한다. 대상 ID/UTC 시각/파일 크기/SHA-256/보관 접근권한/복구 담당자를 기록한다. 보유 옛 복제본은 이 백업을 대체하지 않는다. bookmark 유효기간과 실제 plan별 복구 가능 기간도 확인한다.
4. 최신 백업의 별도 로컬 복사본에서 아래 두 파일을 순서대로 적용하고 원본 데이터 fingerprint/Trigger/정산 결과 및 복구 리허설을 다시 확인한다. 새 데이터로 결과가 달라지면 사유 대조 후 승인받는다.
5. M0 유지 중 migration 1 `20261025_extension_receipts.sql`, migration 2 `20261026_root_settlement_review.sql` 순서로 적용한다. `20261027_part_time_actors.sql`은 포함하지 않는다. 현재 두 파일이 미적용인지 schema/column/view/trigger로 확인하고 migration ledger 유무도 별도로 기록한다. `d1 execute`는 Wrangler migration ledger를 자동 생성하지 않으므로 자동 migrate 명령과 혼용하지 않는다.
6. 두 SQL 모두 성공하고 schema/금액/원장/감사 불변 확인 후 **F0**를 100% 적용한다. 정상/연장 미납/원주문 검토/복합 주문, 100/101/500 목록, 일별 매출·현금마감을 HMAC signed read로 확인한다. F0는 변경 요청을 계속 막는다. 고객 개인정보를 로그나 공개 리포트에 출력하지 않는다.
7. 현장/재무/연동/Cloudflare/변경 책임자가 F1 개방을 공동 승인한다. 신규 수납 대상과 정산 검토를 분리하여 표시하는 Unified Admin 배포 계약도 확인한다. F1을 100% 적용한 시점부터 cron과 업무 요청이 재개될 수 있음을 고려한다.
8. 최초 요청의 결과·409 사유·원장 중복·pickup audit 원자성·현금/QR 수납일·첫 cron 결과를 확인한다. 검토 ¥450은 자동 수납/면제/인도 승인하지 않는다. 재무 정책상 인도가 차단되므로 현장 대응 계획이 없으면 F1 개방 보류.
9. Reviewer 큐 및 외부 Writer는 대조 완료된 작업부터 담당자 승인을 받아 단계적으로 재개한다. CI/Builds는 최종 소스/설정과 검증된 artifact의 일치, 파트타임 미포함 확인 후 마지막으로 재개한다.

### 승인 후 운영자가 사용할 명령 예시 — 문서용, 실행 금지

아래 변수는 민감값이 아니다. 토큰은 안전한 기존 인증 경로를 사용하고 화면/로그에 출력하지 않는다. 각 명령 실행 전 대상 계정·ID·해시와 승인 번호를 다시 확인한다. 자동 일괄 실행 스크립트로 묶지 않는다.

```sh
FINANCE_WORKER_DIR=/Users/yunseoyun/flying/repos-latest/int-center-luggage-finance-f0-f1/worker
FINANCE_RELEASE_DIR=/private/var/folders/nk/jn0bzpjs1x78b_56_dx4n89h0000gn/T/flying-finance-release-XeOZGX
CLOUDFLARE_ACCOUNT_ID=6efe0c5d58f6e8bb28165c599fa36c33
export CLOUDFLARE_ACCOUNT_ID
cd "$FINANCE_WORKER_DIR"
```

최신 백업 단계에서 DB 담당자가 대상/권한을 확인한 후 사용할 예시다. `FINANCE_BACKUP_DIR`는 사전 승인된 새 비공개 디렉터리여야 하며 기존 백업을 덮어쓰지 않는다. export 성공 여부와 파일 SHA, UTC 시각, bookmark를 기록하고 내용은 출력하지 않는다.

```sh
pnpm exec wrangler d1 time-travel info center-luggage-db --config wrangler.toml
pnpm exec wrangler d1 export center-luggage-db --remote --config wrangler.toml --output "$FINANCE_BACKUP_DIR/before-finance.sql"
shasum -a 256 "$FINANCE_BACKUP_DIR/before-finance.sql"
```

원본 migration SHA:
- 1: `64384e8308fa825fdb0afe1136038371c2f58e2b9e4d4b4b6d10099a0b95d5e9`
- 2: `f51217dc29c5a10b0b159a6508696d130f8fb788bc51c1a1955202b025161437`

**Wrangler 4.73.0 SQL splitter 주의:** CASE의 `END,`/`END)` 구분에서 원문 그대로의 CLI 분할이 실패할 수 있다. 금융 SQL 원문을 바꾸지 않고 END token 뒤에 공백만 추가한 CLI 파일을 생성했다. 문자열/컬럼/조건/Trigger 내용의 token 동등성을 검사했고, 실제 Wrangler local 실행 및 각 파일 중간 실패의 전체 DDL rollback을 검증했다. 운영 승인도 반드시 아래 파생 파일의 해시를 대상으로 한다. 원문이나 다른 CLI 버전으로 무검증 교체하지 않는다.

- 파생 1 SHA: `2b5b2509d1b0ae98a9aedbdfecfb43ae21a9e9ed223c34920b9f58c1ed780e49`
- 파생 2 SHA: `d63e26a6313f74ff1c830fa1b76b18a65eab81f11b9329828020ddb1a7cce7f2`

```sh
# 1 성공·schema 검사·승인 후에만 2 실행. 이 두 파일을 묶은 원자성은 없다.
pnpm exec wrangler d1 execute center-luggage-db --remote --config wrangler.toml --file "$FINANCE_RELEASE_DIR/cli-migrations/1-20261025_extension_receipts.sql"
pnpm exec wrangler d1 execute center-luggage-db --remote --config wrangler.toml --file "$FINANCE_RELEASE_DIR/cli-migrations/2-20261026_root_settlement_review.sql"
```

```sh
# 재빌드 대신 검증된 prebuilt artifact. 로컬 --no-bundle dry-run에서 동일 바이트 확인 완료.
pnpm exec wrangler deploy "$FINANCE_RELEASE_DIR/F0/bundle/index.f0.js" --no-bundle --config wrangler.toml --keep-vars
# F0 검증과 F1 개방 승인이 모두 끝난 뒤 별도 실행:
pnpm exec wrangler deploy "$FINANCE_RELEASE_DIR/F1/bundle/index.js" --no-bundle --config wrangler.f1.toml --keep-vars
```

source/config/artifact hash는 final-manifest와 report.json을 대조한다. M0 배포/backup/export/restore 명령은 DB 담당자의 정지 시점 대상/보관 경로/bookmark가 확정된 승인서로 실행한다. 검증하지 않은 이전 bookmark 문자열이나 복원 대상 경로를 이 문서에 고정하지 않는다.

## 7. 실패 시 중단 및 복구

| 실패 지점 | 즉시 조치 | 다음 단계 조건 |
|---|---|---|
| M0 적용/우회 차단/작업 종결 실패 | DB 미변경 유지, 신규 실행 금지, 담당자 소집 | 모든 Writer 및 진행 작업 증빙 확보 |
| migration 1 실패 | M0 유지, schema와 작업 로그 검사 | per-file rollback 확인 후 원인 수정 또는 승인된 복원 |
| 1 성공/2 실패 | M0 유지. 1을 무조건 재실행하지 않는다 (ALTER 중복 위험) | 부분 schema를 판별하고 2 재시도/forward fix/정지 시점 복구 중 승인 |
| F0 조회/schema/정산 결과 오류 | M0 또는 F0 차단 유지, F1 개방 금지 | 백업과 원장 대조, 원인 확인 |
| F1 개방 후 오류 | 즉시 F0 또는 M0 100%로 재차단, 외부 Writer/큐 재정지 | 개방 후 모든 수납/픽업/외부 변경 보존 후 forward fix 승인 |

**구형 Worker + 신규 DB는 쓰기 rollback 대상으로 사용하지 않는다.** 로컬 검증에서 구형 정상 픽업 일부는 성공하지만, 신규 원장 보호가 있는 결제 토글은 500으로 실패하고, legacy-only 원장은 구형 토글이 삭제할 수 있었다. 따라서 운영 기본 버전으로 단순 rollback하면 안전하지 않다. M0는 schema 의존성이 없고 F0는 완성된 신규 schema의 읽기만 수행한다.

- F1 개방 전, 정지 시점 이후 업무 쓰기 0건이 입증된 경우에만 최신 승인 bookmark/SQL 백업으로 D1 복구를 검토한다. schema를 DROP/DELETE로 역수정하거나 금액을 맞추지 않는다.
- F1 개방 후에는 정지 시점 restore가 새 영수증/픽업/감사 이벤트를 잃을 수 있다. 새 상태의 보존·차이 대조·별도 복구 승인이 필요하며 기본 선택은 재차단 후 forward fix다.
- Time Travel restore는 DB를 덮어쓰고 진행 쿼리를 취소한다. DB 담당자가 복원 전 현 bookmark와 대상 bookmark를 기록하고 실행 후 schema·모든 금액·원장·감사 일관성을 확인한다. SQL 백업은 별도 DB에서 먼저 복원 검증한다. 운영 DB에 동일 SQL을 추가 import하는 것은 복구가 아니다.
- R2는 D1 복원으로 돌아가지 않는다. 객체 key/주문 연결을 별도 대조하고 임의 삭제하지 않는다. Supabase/Brevo/Asana 및 발송 완료 알림도 돌아가지 않으므로 서비스 담당자가 중복/누락을 별도 처리한다.
- 복원은 별도 파괴적 작업 승인을 받은 DB 담당자만 수행한다. 다음은 대상과 freeze-time bookmark가 승인된 경우의 문서용 예시다. 변수가 비어 있거나 승인 시점과 다르면 실행하지 않는다. 자동 확인 옵션을 추가하지 않는다.

```sh
pnpm exec wrangler d1 time-travel restore center-luggage-db --bookmark "$FINANCE_APPROVED_BOOKMARK" --config wrangler.toml
```

- 복원 후 구형 서비스 재개는 DB가 정확한 구형 schema/데이터로 돌아갔고 개방 후 업무 쓰기 손실이 없다는 증빙과 재무 책임자 승인이 있어야 한다.

## 8. 로컬 재현과 검증 범위

```sh
pnpm typecheck
pnpm lint
FINANCE_RELEASE_TEST_PHASE=F0 pnpm test
FINANCE_RELEASE_TEST_PHASE=F1 pnpm test
node scripts/verify-d1-http.local.mjs --run-local
node scripts/verify-d1-pickup.local.mjs --run-local
python3 scripts/prepare-finance-rehearsal.py --run-local --source /Users/yunseoyun/.center-luggage-rehearsal.J4ArXw/rehearsal-before-migration.sqlite
# 직전 명령이 새로 출력한 격리 경로를 사용한다. 원본/기존 state 경로 사용 금지.
node scripts/verify-finance-release.local.mjs --run-local --rehearsal /path/to/new/flying-finance-rehearsal-XXXX

git diff --check
```

- F0/F1 전체 각 193 PASS (재무/기존 188 + 고정 게이트 5). 파트타임 전용 테스트는 후보 기능 범위에서 제외했고 역할 거부 테스트를 추가했다.
- 실제 local D1 HTTP 21/21, 재무 시나리오 7/7, 실제 Wrangler 생성 번들 및 구형/신규 DB 조합 36개 검증 PASS.
- 두 번들 패키징은 OS deny-network 및 Node network guard 안에서 dry-run. 업로드 0, 네트워크 시도 0. prebuilt --no-bundle 경로도 dry-run에서 바이트 동일 확인.
- 실제 CLI local D1 마이그레이션은 outbound를 loopback으로 제한했고 각 SQL 파일에 의도적 실패를 넣어 전체 rollback을 확인했다. 원본 두 migration과 최종 schema를 token 기준 대조했다.
- 보유 데이터: 주문 26,978 / 수납 원장 12,099 / 감사 54,644. 기존 모든 테이블의 기존 컬럼 값 fingerprint 불변. 정산 검토 366/¥348,839 = PAID 1/¥450 + PICKED_UP 365/¥348,389. 과거 주문 소급 변경 없음.
- 이 숫자는 **보유 복제본 기준**이며 적용일 운영 예상 숫자로 강제하지 않는다. 본 작업은 원격 계정/스키마/flags/Secret/공유 Writer/현재 CI 상태를 확인하지 않았다.
- 로컬 loopback workerd와 운영 Cloudflare의 네트워크·실행 제한·분산 동시성은 같지 않다. 로컬 통과를 원격 import 원자성이나 진행 작업 전수 종결의 증명으로 사용하지 않는다.
- Unified Admin 코드는 이번에 수정/배포하지 않았다. 로컬 참고 코드의 `src/lib/luggage/billing.ts`는 누락/비정상 billing을 fail-closed로 처리하고 원주문 검토와 연장 미납을 분리하며 PAID 토글을 차단한다. 이는 운영 배포 증명이 아니다. 파트타임 actor를 보내는 호출은 본 후보에서 지원하지 않으므로 관련 기능 플래그를 켜지 않는다. 배포 중인 버전의 billing 전달, 정산 검토 0원 차단, 409 분기, 구형 수납 토글 차단, 재조회 동작은 연동 담당자의 개방 전 체크다.

## 9. 남은 P0 / 판정

현재 운영 전환 **NO-GO**: 최신 정지 시점 백업·복구 승인, 모든 진행 작업의 종결, Version/alias/별도 Preview 우회 차단, 공유/직접 Writer 통제, Actions+Builds 동결, Reviewer 재시도 선별 재개, 현재 운영 바인딩/vars/Secret 이름 및 Unified Admin 배포 호환성, 활성 정산 검토 주문의 현장 처리 승인 모두 미완료다. 이 문서는 해당 운영 상태를 변경하지 않았다.

## 공식 근거

- [Wrangler deploy 옵션](https://developers.cloudflare.com/workers/wrangler/commands/deploy/): dry-run/outdir/no-bundle/keep-vars는 로컬 설치 버전 help와 실제 출력으로도 확인했다.
- [Version URLs 및 alias 비활성화](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)
- [Workers Previews](https://developers.cloudflare.com/workers/previews/): 별도 리소스/격리 및 배포 경로로 점검한다.
- [Wrangler configuration source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
