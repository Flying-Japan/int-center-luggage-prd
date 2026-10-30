# 2026-10-30 센터 통합 후보 — 추가 짐 + 알바 업무 actor

운영 미적용 후보다. 실제 직원 계정 생성 대상은 승인되지 않았으므로 계정 생성·정지·비밀번호 변경·초대·메일은 실행하지 않는다. 다른 작업의 원본 checkout은 변경하지 않는다.

## 통합 기준과 검증 경계

- 어드민 a8531a6, 현재 운영 F1 Worker 237ffa2 위의 추가 짐 후보에 검증된 알바 패치를 통합했다.
- 알바 인계 패치 SHA-256: admin `0768c4768b7418fd598a8144e0986e030d72f426e6dcc8808d5271a7fd8fd790`, Worker `923e660703156d464f74f7100fc5575e6262c27a6dd0767298d910579b80ed8b`.
- Worker 충돌 5개는 양쪽 의미를 보존했다. 환급 router → 일반 알바 gate → 추가 짐 및 일반 업무 router 순서다. 환급용·일반 알바 switch는 독립이다.
- 추가 짐 API도 검증된 Part-time Auth 세션의 실제 ERP UUID/name/role을 HMAC으로 전달한다. 작업자 ID는 `pt:<ERP UID>`이며 공용 editor를 사용하지 않는다. 이름 저장과 업무 감사·추가 청구·수납은 같은 D1 batch에서 성공하거나 모두 롤백한다.
- 기존 짐의 기간·할인과 각 추가 배치의 독립 기간·단가·장기 할인 및 원수납 불변을 유지한다. 알바 source switch OFF면 API와 화면 capability 모두 닫힌다.
- 검증은 합성 자료·격리 D1·외부 egress 차단 HTTP만 사용한다. 실제 운영 로그인/계정 생성으로 표현하지 않는다. 기존 Auth 실험실 15건은 계정 코드가 바뀌지 않은 별도 계층의 인계 근거다.

## 최종 후보 게이트

최종 통합 commit 기준으로 어드민/Worker typecheck·전체 회귀, 추가 짐+native 알바 D1 통합, 기존 HTTP 91개, 생산용 빌드·F1 dry-run·CI·검토를 통과해야 한다. 테스트 실패를 flag/과금 보호 완화나 쓰기 재시도로 통과시키지 않는다. 개별 원본 worktree의 dirty build를 배포하지 않는다.

```sh
# admin checkout
LUGGAGE_WORKER_DIR=/tmp/flying-bag-additions-20261030/worker-clean/worker \
  node scripts/luggage-handover-local-e2e.mjs --f1 --keep
LUGGAGE_WORKER_DIR=/tmp/flying-bag-additions-20261030/worker-clean/worker \
  node scripts/bag-additions-local-e2e.mjs --run-local
pnpm typecheck
pnpm test
pnpm prod:build:public-env
```

`--f1`은 원본 설정을 바꾸지 않고 격리 복사본에 F1 설정을 선택한다. HTTP 검증은 계정/원천 profile GET stub 외 외부 요청을 차단하며 미확인 쓰기를 재시도하지 않는다.

## 21시 이후 배포 순서

첫 운영 쓰기 전에 반드시 시간·최종 검토·CI와 fresh 운영 snapshot을 다시 확인한다. 21시는 Asia/Tokyo 기준 2026-10-30 12:00 UTC다.

```sh
python3 - <<'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
assert datetime.now(ZoneInfo('Asia/Tokyo')) >= datetime(2026,10,30,21,0,tzinfo=ZoneInfo('Asia/Tokyo'))
PY
```

1. 새 운영 version·설정·cron·schema 정의와 원장/환급/마감/감사 데이터를 비공개 백업한다. 조사 당시 version은 Worker `2ba59dac-0250-434e-8840-74803a9c5b6e`, 어드민 `ba10a608-3d28-4479-abb8-c868d1735fa2`지만, 달라졌으면 이 값을 강제하거나 그대로 rollback하지 않는다. 동시에 다른 배포가 진행되면 조율 후 새 기준을 만든다.
2. 다음 **두 신규 migration**만 필요한 부분을 원자적 D1 batch로 적용한다. actor 테이블이 이미 있으면 정확한 정의를 대조해 같을 때만 건너뛴다. 추가 짐 테이블이 이미 있으면 적용 결과·hash를 먼저 확인하고 재실행하지 않는다. 정의가 다르면 중단한다. `schema.sql` 전체나 이전 billing/refund migration을 다시 실행하지 않는다.
   - `migrations/20261027_part_time_actors.sql`: actor 표시 이름 테이블 1개 생성만. SHA-256 `95a3facb5740ada5b0feaeff0a08b508ca119bce063b3e1815e4d8e71ae1bd0e`.
   - `migrations/20261030_bag_additions.sql`: 불변 배치 기록/보호와 청구·수량 통계 해석. SHA-256 `1293cd6f375f9514997b37145d1a0e3b3e57a6466b862a8deda783ef5885726f`.
   - 기존 운영 정의 134개를 사용한 격리 리허설에서 새 정의 19개 추가, 의도한 기존 정의 7개 변경 외 모든 기존 보호 정의는 byte-identical이며 거래 rollback으로 원형 복구됨을 확인했다. D1 통합 검증은 migration 전의 결제 완료 주문/수납행과 계산 결과 보존도 대조한다.
3. 최종 pushed clean Worker commit을 **F1**으로 먼저 준비 배포한다. 신규 두 기능은 OFF이며 기존 환급 flag 두 개와 다른 변수·Secret·cron은 유지한다. 아래는 명령 형태이며, 실제 실행 전 fresh snapshot/코드 hash를 대조한다.

```sh
# Worker checkout / worker
release_worker_commit=$(git rev-parse HEAD)
test -z "$(git status --porcelain)" || exit 1
./node_modules/.bin/wrangler deploy --config wrangler.f1.toml --keep-vars \
  --var LUGGAGE_PART_TIME_ACTORS_ENABLED:false --var LUGGAGE_BAG_ADDITIONS_ENABLED:false \
  --var "SENTRY_RELEASE:int-center-luggage-prd@$release_worker_commit" \
  --tag "$release_worker_commit" --message "Prepared center rollout; new registrations off" --dry-run
```

같은 명령의 `--dry-run`을 제거하는 것은 최종 검토·시간·migration 검증 후다. 결과 version을 읽어 기존 `LUGGAGE_FLYING_PASS_REFUNDS_ENABLED=true`, `LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED=true`, 다른 Secret 이름/종류·binding·cron 보존과 F1 read-only 스모크를 확인한다. 기본 `wrangler.toml`과 기존 main 자동 배포는 F0이므로 사용하지 않는다.

4. 어드민은 최종 검토된 통합 commit을 기존 clean/pushed origin/main guard에 맞춰 통합한 뒤 빌드한다. guard를 바꾸거나 `--skip-tests`로 우회하지 않는다. 현재 환급 profile의 기존 25개 flag를 보존하고 추가 짐 flag 1개를 더하는 profile을 쓴다. 원천 신규 등록이 OFF인 동안 UI 쓰기는 원천에서 닫혀 있다.

```sh
# admin checkout; final reviewed origin/main only
release_previous_assets=/Users/yunseoyun/Documents/Codex/2026-10-29/task/release-evidence/refund-handover-20261029/assets/ba10a608-3d28-4479-abb8-c868d1735fa2
pnpm prod:build:public-env
pnpm prod:profile --phase1-b-field-luggage-bag-additions \
  --previous-assets "$release_previous_assets" --wrangler-dry-run
# After the guards and dry-run succeed:
pnpm prod:profile --phase1-b-field-luggage-bag-additions \
  --previous-assets "$release_previous_assets" \
  --archive-assets /Users/yunseoyun/Documents/Codex/2026-10-29/task/release-evidence/center-deployed-assets \
  --apply --yes
```

이전 asset 보관본은 fresh 운영 asset과 hash를 대조한다. 운영 버전이 바뀌었다면 해당 새 버전의 실제 보관본으로 바꾼다. 공개 로그인 URL/key·Part-time 로그인·계정 관리·RPC-ready flag·Secret·기존 환급/다른 쓰기를 보존한다.

5. 두 앱 조회·로그인 HTML·asset·기존 환급·마감 스모크가 확인되면 **같은 통합 F1 코드**를 두 source flag `true`로 활성화한다. `--keep-vars`, 최종 tag, F1 config를 유지한다. 새 version을 읽어 일반 알바/BAG=true, 기존 환급용 알바/환급=true와 나머지 변수·binding·cron 불변을 확인한다. 어드민 source capability도 읽어 일치하는지 확인한다. 실제 지급·외부 결제·가짜 수납/환급이나 테스트 고객 주문을 운영에 만들지 않는다.
6. 실제 직원 계정 대상자가 승인되기 전에는 생성/정지/비밀번호/메일을 실행하지 않는다. 첫 실제 승인된 업무가 발생하면 ERP UID/name/role·추가 배치 기간/할인·수납·마감 귀속을 읽기 전용으로 대조한다.

## 롤백과 불확실 결과

- 신규 기능 문제는 먼저 일반 알바/BAG source flag를 OFF로 하고 어드민을 REFUNDS profile로 축소한다. 기존 환급용 스위치 두 개는 켜 둔다. 새 청구를 아는 통합 Worker와 직원/관리자의 실제 미수납 수납 복구 경로를 유지한다.
- 새 추가 짐 이력이 생겼다면 새 청구를 모르는 구버전 Worker/청구 view로 자동 rollback하지 않는다. 준비 배포한 동일 통합 코드의 OFF version을 우선 사용한다. 원래 version으로 코드 복귀는 새 데이터 호환성을 따로 검증한 뒤에만 한다.
- actor/배치 테이블·감사·원장·마감 snapshot은 삭제하거나 덮어쓰지 않는다. DB import 실패는 재조회로 실제 적용/미실행/부분 적용을 구분한 뒤 처리한다. 결과가 불명확한 원장 쓰기·배포를 맹목적으로 반복하지 않는다.
- 배포 전 fresh version/asset 보관본이 rollback 기준이다. 어드민 asset 보존 guard도 rollback에 그대로 적용한다. source flag·기존 환급·로그인·Secret·cron read-back과 read-only 스모크까지 확인한다.
