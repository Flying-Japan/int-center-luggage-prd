# UA-LUG-028: 짐보관 번호 내림차순

## 범위와 승인

10/21 Develop 원문과 화면의 41→40→…28→26 사이에 수기27이 배치되어야 한다는 근거에 따른다. 통합어드민 `/luggage` 주문 화면만 번호 숫자 내림차순으로 정렬한다. 10/31 09:00 JST 이전 운영 배포를 승인받았다. 번호 재배정이나 데이터 수정은 아니다.

## 동작

- Worker `/internal/luggage-orders?sort=tag_desc`만 원천 SQL에서 전체 결과를 정렬한 뒤 LIMIT/OFFSET을 적용한다. 정렬 인자가 없거나 알 수 없는 값이면 기존 created_at DESC/order_id DESC를 유지한다. legacy staff 및 다른 서비스 기본값과 연장 하위목록은 바꾸지 않는다.
- 유효한 양의 안전 정수 번호(숫자 문자열, 선행0, `.0` 포함)를 내림차순으로 배치한다. 기존 normalizer의 String.trim과 동일한 공백 규칙을 사용한다. 미지정·공백·잘못된 번호는 마지막이다. 같은 번호 및 미지정끼리는 created_at DESC, order_id DESC다. 장기146~150을 재배정하거나 숨기지 않는다.
- 서버 화면 쿼리가 같은 opt-in을 모든 컬럼필터 수집 페이지에 전달한다. 상태·검색·기간·페이지 크기·권한·변경토큰·금융 projection은 그대로다.
- 표 렌더는 같은 비교 규칙을 복사본에 적용한다. 수기/연장 등록 직후 임시 행도 바로 번호순이며 기존 상세·결제·수령·환급·등록 성공과 router.refresh 흐름은 유지한다. 원본 배열을 변경하지 않는다.

## 검증

Worker 실제 SQL/HMAC 테스트는 숫자/문자/null/잘못된 값/중복/.0/Unicode 공백/다페이지/필터/기존 금융응답/미인증 거부/10,000합성 행을 포함한다. admin은 local prepend·번호수정·배열 불변·tie·공백·opt-in 범위·원천여러페이지 컬럼필터를 검증한다. 전체 회귀/typecheck, 고정SHA CI, 독립 검토 및 F1/production 빌드를 게이트로 삼는다.

## 배포와 복구

fresh official Wrangler 비대화형 read로 운영 버전/변수/secret 이름/리소스 binding을 저장하고 원격 변경을 확인한다. 직접 토큰 파일 읽기/직접 refresh/새 grant는 사용하지 않는다. 인증거부나 새 로그인 요구는 중단한다.

Worker는 기본 main/F0 배포를 사용하지 않고 검토된 F1 release branch를 통합한다. 기존 모든 기능 flag/cron/보호/secret/binding을 보존해 F1을 먼저 배포한다. 이어 검토된 admin main/clean build에 같은 현재 profile과 실제 직전 assets 보존 guard를 적용한다. DB migration이나 고객 write는 하지 않는다.

수령/수납/환급 동작을 운영 테스트하지 않는다. 실제 주문 화면의 번호순과 읽기 권한·공개 로그인/정적 파일 및 배포 후 설정을 재조회한다. 실패 시 원인을 확인하고 같은 write를 반복하지 않는다. 복구가 필요하면 이번 직전 버전(db70046 F1 및83dec811 admin, 이미 추가짐 데이터를 이해하는 버전)만 검토하며 더 오래된 F0/과금 view로 돌아가지 않는다.
