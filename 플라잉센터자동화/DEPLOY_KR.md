# 실사용 배포 가이드 (무추가비용 우선)

## 1) 전제

- 신규 유료 서비스 없이, **기존 회사 서버**에 이 앱을 배포
- 서버에 Docker/HTTPS(리버스프록시)만 준비

## 2) IT 담당자에게 필요한 최소 확인

- 기존 서버에 `Docker` 실행 가능
- 외부 접속 가능한 도메인(또는 사내 고정 IP)
- HTTPS 인증서 적용 가능(Caddy/Nginx/Load Balancer)
- 기존 DB 사용 시 `PostgreSQL` 접속정보 제공 가능

## 3) 배포 절차

```bash
git clone <repo>
cd <repo>
cp .env.example .env
```

`.env` 필수 수정:

- `APP_SECRET_KEY` 랜덤 긴 문자열로 변경
- `APP_ENV=production`
- `AUTO_SEED_DEFAULT_STAFF=false`
- DB를 별도로 쓰면 `DATABASE_URL` 변경

실행:

```bash
docker compose up -d --build
```

## 4) 초기 운영 계정 생성

```bash
docker compose exec app python scripts/create_staff.py --name admin01 --pin 4829 --admin
docker compose exec app python scripts/create_staff.py --name staff01 --pin 0000
```

## 5) 운영 점검

- `/health` 응답 확인
- 고객 접수 `/customer`에서 사진 업로드/접수 완료 테스트
- 직원 로그인 `/staff/login` 테스트
- 보관기간 정리 스크립트 동작 테스트

```bash
docker compose exec app python scripts/retention_cleanup.py
```
