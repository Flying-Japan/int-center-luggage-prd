# Flying Japan - Luggage Storage MVP

PRD 기반으로 구현한 `FastAPI` 시스템입니다.  
개발 기본값은 `SQLite`이고, 운영에서는 `DATABASE_URL`로 `PostgreSQL`도 연결할 수 있습니다.

## 구현 범위

- 고객 모바일 접수
  - 이름/전화/신분증 사진/짐 사진/수량/예정 픽업/동의
  - 실시간 요금 미리보기(`/api/price-preview`)
  - 자동 SET 매칭 + 장기할인 반영 선결제 금액 계산
  - 접수 완료 시 일일 시퀀스 `order_id` 표시 (예: `20260219-001`)
  - QR 코드 표시
- 직원 화면
  - PIN 로그인
  - 결제 대기/검색/상세
  - 결제 완료 처리
  - tag_no 수동 입력
  - 수령 완료 처리 + 초과일 후불 계산
  - 허용 항목 수정(이름/전화/tag_no/예정 픽업/상태)
  - 수기접수(manual_entry=true) 생성
- 보안/개인정보
  - 이미지 열람 엔드포인트 분리
  - 열람 시 `audit_logs` 기록 (`VIEW_ID`, `VIEW_LUGGAGE`)
  - 14일/60일 보관정책 정리 스크립트 제공
- 확장 기반
  - 테이블 구조 및 서비스 레이어 분리
  - 서비스 타입 확장은 이후 `orders`에 필드 추가로 확장 가능

## 정책 반영 요약

- 영업시간: 09:00~21:00 JST (예정 픽업 입력 시 검증)
- 보관일: `created_at` 기준 수령일(현지 날짜) 포함 계산
- 결제: 접수 시 선결제 계산, 실수령 초과일은 할인 없이 정가 후불
- 할인: 1~6(0%), 7~13(5%), 14~29(10%), 30~59(15%), 60+(20%)

## 로컬 실행

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

브라우저:

- 고객 화면: `http://127.0.0.1:8000/customer`
- 직원 로그인: `http://127.0.0.1:8000/staff/login`

기본 직원 계정:

- `admin / 1234`
- `staff / 0000`

운영 환경에서는 기본 계정 자동 생성이 꺼지도록 `AUTO_SEED_DEFAULT_STAFF=false`를 사용하세요.

## 운영(무추가비용) 실행 예시

기존 회사 서버(또는 사내 PC)에 Docker로 올리면 추가 월비용 없이 운영 가능합니다.

```bash
cp .env.example .env
# .env에서 APP_SECRET_KEY를 반드시 변경
docker compose up -d --build
```

접속:

- 고객: `http://<서버IP>:8000/customer`
- 직원: `http://<서버IP>:8000/staff/login`

## 운영 환경변수

- `APP_ENV`: `development` / `production`
- `APP_SECRET_KEY`: 세션 암호화 키(필수)
- `DATABASE_URL`: 미설정 시 SQLite 사용
  - 예시(SQLite): `sqlite:////app/data/flying_japan.db`
  - 예시(PostgreSQL): `postgresql+psycopg://user:pass@host:5432/dbname`
- `DATA_DIR`, `UPLOAD_DIR`: 로컬 저장 경로
- `SESSION_HTTPS_ONLY`: 운영 HTTPS 강제 여부
- `AUTO_SEED_DEFAULT_STAFF`: 기본 계정 자동 생성 여부

## 유지보수 명령

테스트:

```bash
python -m unittest discover -s tests -v
```

보관기간 정리:

```bash
python scripts/retention_cleanup.py
```

운영 계정 생성/수정:

```bash
# 신규 관리자 생성
python scripts/create_staff.py --name manager --pin 4829 --admin

# 기존 계정 PIN/권한 변경
python scripts/create_staff.py --name manager --pin 7391 --admin --update-existing
```

## 주요 파일

- `app/main.py`: 라우트/업무흐름
- `app/models.py`: DB 모델
- `app/services/pricing.py`: 요금/할인 계산
- `app/services/storage.py`: 보관일 계산
- `app/services/retention.py`: 개인정보/기록 보관기간 정리
- `templates/*.html`: 고객/직원 UI
- `static/customer.js`: 실시간 요금 조회
