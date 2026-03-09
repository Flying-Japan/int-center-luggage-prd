# 보안 감사 리포트

**프로젝트:** int-center-luggage-prd (Flying Japan Luggage Storage)
**점검일:** 2026-03-09
**기술 스택:** Python/FastAPI + Supabase + Cloudflare R2 + Cloudflare Tunnel + Docker
**점검 범위:** 8개 카테고리, 주요 소스 파일 20개 분석

## 요약

| 심각도 | 발견 수 |
|--------|---------|
| CRITICAL | 3 |
| HIGH | 4 |
| MEDIUM | 3 |
| LOW | 3 |
| **총계** | **13** |

---

## 발견된 취약점

### [CRITICAL-1] 프로덕션 에러 응답에 스택 트레이스 전체 노출
- **심각도:** CRITICAL
- **카테고리:** 정보 노출
- **위치:** `app/main.py:114-123`
- **설명:** 글로벌 예외 핸들러가 에러 발생 시 `detail`, `type`, `traceback` 전체를 JSON 응답으로 클라이언트에 반환합니다.
- **영향:** 내부 코드 경로, 파일 구조, 변수 값, DB 쿼리 등 민감한 정보가 외부에 노출됩니다. 공격자가 이를 통해 시스템 구조를 파악하고 추가 공격에 활용할 수 있습니다.
- **수정 방법:**
  ```python
  # 수정 전
  @app.exception_handler(Exception)
  async def _global_exception_handler(request: Request, exc: Exception):
      tb = traceback.format_exc()
      detail = str(exc)
      exc_type = type(exc).__name__
      logger.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, tb)
      return JSONResponse(status_code=500, content={"detail": detail, "type": exc_type, "traceback": tb})

  # 수정 후
  @app.exception_handler(Exception)
  async def _global_exception_handler(request: Request, exc: Exception):
      logger.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, traceback.format_exc())
      return JSONResponse(status_code=500, content={"detail": "Internal server error"})
  ```

---

### [CRITICAL-2] 인증 없는 디버그 진단 엔드포인트
- **심각도:** CRITICAL
- **카테고리:** 인증/인가
- **위치:** `app/main.py:126-186`
- **설명:** `/debug/dashboard-diag` 엔드포인트에 인증 체크가 전혀 없습니다. 누구나 접근하여 직원 이름, 주문 데이터, 내부 함수 결과, 트레이스백을 확인할 수 있습니다.
- **영향:** 직원 정보, 주문 데이터, 내부 시스템 구조가 인터넷에 완전히 노출됩니다.
- **수정 방법:**
  ```python
  # 수정 전
  @app.get("/debug/dashboard-diag")
  def debug_dashboard_diag(db: SupabaseDB = Depends(get_db)):

  # 수정 후 — 프로덕션에서 제거하거나 admin 인증 추가
  @app.get("/debug/dashboard-diag")
  def debug_dashboard_diag(request: Request, db: SupabaseDB = Depends(get_db)):
      _ = get_current_staff(request, db, require_admin=True)
  ```
  또는 프로덕션 빌드에서 해당 엔드포인트를 완전히 제거하세요.

---

### [CRITICAL-3] 인증 없는 주문 조회 API
- **심각도:** CRITICAL
- **카테고리:** 인증/인가
- **위치:** `app/main.py:1067-1072`
- **설명:** `/api/orders/{order_id}` 엔드포인트가 인증 없이 고객 이름, 전화번호, 결제 정보를 반환합니다.
- **영향:** order_id를 추측/열거하여 모든 고객의 개인정보(PII)에 접근할 수 있습니다.
- **수정 방법:**
  ```python
  # 수정 전
  @app.get("/api/orders/{order_id}", response_model=OrderSummaryResponse)
  def api_order(order_id: str, db: SupabaseDB = Depends(get_db)):

  # 수정 후 — 인증 추가 또는 엔드포인트 제거
  @app.get("/api/orders/{order_id}", response_model=OrderSummaryResponse)
  def api_order(request: Request, order_id: str, db: SupabaseDB = Depends(get_db)):
      _ = ensure_staff(request, db)
  ```
  고객용 확인 페이지(`/customer/orders/{order_id}`)가 이미 존재하므로 이 API가 불필요할 수 있습니다.

---

### [HIGH-1] Rate Limiting 없음
- **심각도:** HIGH
- **카테고리:** Rate Limiting
- **위치:** 전체 애플리케이션
- **설명:** 어떤 엔드포인트에도 rate limiting이 적용되어 있지 않습니다. `requirements.txt`에 rate limiting 라이브러리가 없습니다.
- **영향:**
  - `/staff/login` — 로그인 브루트포스 공격 가능
  - `/customer/submit` — 대량 주문 생성 + 파일 업로드로 스토리지/비용 남용
  - `/staff/api/orders/bulk-action` — 대량 상태 변경 남용
- **수정 방법:**
  ```bash
  pip install slowapi
  ```
  ```python
  from slowapi import Limiter
  from slowapi.util import get_remote_address

  limiter = Limiter(key_func=get_remote_address)
  app.state.limiter = limiter

  @app.post("/staff/login")
  @limiter.limit("5/minute")
  def staff_login(request: Request, ...):
  ```

---

### [HIGH-2] 파일 업로드 크기 제한 없음
- **심각도:** HIGH
- **카테고리:** 파일 업로드 보안
- **위치:** `app/main.py:233-247` (`save_image_file`)
- **설명:** `save_image_file`이 파일 크기 검증 없이 전체 파일을 메모리에 읽습니다 (`upload.file.read()`). FastAPI에도 `max_upload_size` 설정이 없습니다.
- **영향:** 공격자가 수 GB 크기의 파일을 업로드하여 서버 메모리 부족(OOM) 및 서비스 거부(DoS)를 유발할 수 있습니다.
- **수정 방법:**
  ```python
  MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10MB

  def save_image_file(upload: UploadFile, folder: str, order_id: str, label: str) -> str:
      if not upload.content_type or not upload.content_type.startswith("image/"):
          raise HTTPException(status_code=400, detail=f"{label} must be an image file.")

      file_bytes = upload.file.read()
      if len(file_bytes) > MAX_IMAGE_SIZE:
          raise HTTPException(status_code=400, detail=f"{label} must be under 10MB.")
      # ...
  ```

---

### [HIGH-3] CSRF 보호 없음
- **심각도:** HIGH
- **카테고리:** 인증/인가
- **위치:** 전체 POST 엔드포인트
- **설명:** 모든 상태 변경 POST 엔드포인트에 CSRF 토큰 검증이 없습니다. `SessionMiddleware`는 CSRF 보호를 제공하지 않습니다.
- **영향:** 로그인한 직원이 악성 사이트를 방문하면, 해당 사이트에서 직원의 세션을 이용하여 주문 취소, 상태 변경, 관리자 계정 생성 등의 조작이 가능합니다.
- **수정 방법:** `starlette-csrf` 또는 커스텀 CSRF 미들웨어를 추가하세요:
  ```bash
  pip install starlette-csrf
  ```
  ```python
  from starlette_csrf import CSRFMiddleware
  app.add_middleware(CSRFMiddleware, secret=SECRET_KEY)
  ```

---

### [HIGH-4] 취약한 기본 시크릿 키
- **심각도:** HIGH
- **카테고리:** 환경변수/시크릿
- **위치:** `app/config.py:23`
- **설명:** `SECRET_KEY = os.getenv("APP_SECRET_KEY", "dev-secret-change-me")` — 환경 변수가 설정되지 않으면 잘 알려진 기본값으로 세션이 서명됩니다.
- **영향:** 기본 키를 아는 공격자가 세션 쿠키를 위조하여 임의의 직원/관리자로 로그인할 수 있습니다.
- **수정 방법:**
  ```python
  # 수정 전
  SECRET_KEY = os.getenv("APP_SECRET_KEY", "dev-secret-change-me")

  # 수정 후 — 프로덕션에서 기본값 사용 시 에러 발생
  SECRET_KEY = os.getenv("APP_SECRET_KEY", "")
  if IS_PRODUCTION and not SECRET_KEY:
      raise RuntimeError("APP_SECRET_KEY must be set in production")
  if not SECRET_KEY:
      SECRET_KEY = "dev-secret-for-local-only"
  ```

---

### [MEDIUM-1] 보안 헤더 미설정
- **심각도:** MEDIUM
- **카테고리:** 정보 노출
- **위치:** 전체 애플리케이션
- **설명:** Content-Security-Policy, X-Frame-Options, X-Content-Type-Options 등 보안 헤더가 설정되어 있지 않습니다.
- **영향:**
  - Clickjacking 공격 가능 (X-Frame-Options 미설정)
  - MIME 스니핑 공격 가능 (X-Content-Type-Options 미설정)
- **수정 방법:**
  ```python
  from starlette.middleware.base import BaseHTTPMiddleware

  class SecurityHeadersMiddleware(BaseHTTPMiddleware):
      async def dispatch(self, request, call_next):
          response = await call_next(request)
          response.headers["X-Frame-Options"] = "DENY"
          response.headers["X-Content-Type-Options"] = "nosniff"
          response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
          return response

  app.add_middleware(SecurityHeadersMiddleware)
  ```

---

### [MEDIUM-2] Service Role Key로 모든 DB 작업 수행
- **심각도:** MEDIUM
- **카테고리:** 인증/인가
- **위치:** `app/database.py:8`, `app/supabase_client.py:236`
- **설명:** 모든 DB 작업이 `SUPABASE_SERVICE_ROLE_KEY`(RLS 우회)로 실행됩니다. 서버 사이드에서는 일반적이나, 만약 앱에 주입 취약점이 있다면 모든 테이블 데이터에 접근 가능합니다.
- **영향:** 단일 취약점으로 전체 데이터베이스가 노출될 수 있습니다.
- **수정 방법:** 현 아키텍처에서는 불가피하나, 다른 취약점 수정을 통해 위험을 최소화하세요.

---

### [MEDIUM-3] 고객 주문 확인 페이지 접근 제어 미흡
- **심각도:** MEDIUM
- **카테고리:** 인증/인가
- **위치:** `app/main.py:1032-1065`
- **설명:** `/customer/orders/{order_id}`는 order_id만 알면 누구나 접근 가능합니다. Order ID가 예측 가능한 패턴이라면 열거 공격에 취약합니다.
- **영향:** 고객의 이름, 전화번호 등 개인정보가 노출될 수 있습니다.
- **수정 방법:** order_id가 충분히 랜덤한 UUID 형태인지 확인하고, 추가로 단기 만료 토큰이나 OTP 기반 접근 제어를 검토하세요.

---

### [LOW-1] GET 방식 로그아웃
- **심각도:** LOW
- **카테고리:** 인증/인가
- **위치:** `app/main.py:1167-1170`
- **설명:** `/staff/logout`이 GET 요청으로 처리됩니다.
- **영향:** 이미지 태그 `<img src="/staff/logout">` 등으로 사용자를 강제 로그아웃시킬 수 있습니다.
- **수정 방법:** POST 방식으로 변경하세요.

---

### [LOW-2] Docker 소켓 Watchtower 노출
- **심각도:** LOW
- **카테고리:** 인프라 보안
- **위치:** `docker-compose.yml:28`
- **설명:** Watchtower에 Docker 소켓(`/var/run/docker.sock`)이 마운트되어 있습니다.
- **영향:** Watchtower 컨테이너가 침해되면 호스트의 전체 Docker API에 접근할 수 있습니다. Watchtower 표준 구성이므로 위험은 낮습니다.
- **수정 방법:** Watchtower를 읽기 전용 Docker 소켓이나 HTTP API 모드로 전환하는 것을 검토하세요.

---

### [LOW-3] 의존성 취약점 점검 미비
- **심각도:** LOW
- **카테고리:** 의존성
- **위치:** `requirements.txt`, `.github/workflows/deploy.yml`
- **설명:** CI/CD 파이프라인에 `pip audit`이나 `safety check` 같은 의존성 취약점 스캐닝이 없습니다.
- **영향:** 알려진 CVE가 있는 패키지가 프로덕션에 배포될 수 있습니다.
- **수정 방법:** GitHub Actions에 추가:
  ```yaml
  - name: Audit dependencies
    run: pip install pip-audit && pip-audit -r 플라잉센터자동화/requirements.txt
  ```

---

## 우선순위 액션 아이템

| 순위 | 심각도 | 난이도 | 액션 | 예상 소요시간 |
|------|--------|--------|------|---------------|
| 1 | CRITICAL | 낮음 | 에러 핸들러에서 traceback 제거 (line 121) | 5분 |
| 2 | CRITICAL | 낮음 | `/debug/dashboard-diag` 제거 또는 admin 인증 추가 | 5분 |
| 3 | CRITICAL | 낮음 | `/api/orders/{order_id}` 인증 추가 또는 제거 | 5분 |
| 4 | HIGH | 낮음 | 기본 SECRET_KEY 프로덕션 차단 | 10분 |
| 5 | HIGH | 낮음 | 파일 업로드 크기 제한 추가 (10MB) | 10분 |
| 6 | HIGH | 중간 | 로그인 엔드포인트에 rate limiting 추가 | 30분 |
| 7 | HIGH | 중간 | CSRF 미들웨어 추가 | 30분 |
| 8 | MEDIUM | 낮음 | 보안 헤더 미들웨어 추가 | 15분 |
| 9 | LOW | 낮음 | 로그아웃 POST로 변경 | 10분 |
| 10 | LOW | 낮음 | CI에 pip-audit 추가 | 10분 |

## 권장사항

1. **즉시 조치 (1-3번):** traceback 노출, debug 엔드포인트, 인증 없는 API는 즉시 수정해야 합니다. 모두 5분 이내에 가능합니다.
2. **이번 주 내 (4-8번):** SECRET_KEY 강화, 파일 크기 제한, rate limiting, CSRF 보호, 보안 헤더를 순차적으로 적용하세요.
3. **장기적:** Supabase RLS 정책을 점검하고, 정기적인 의존성 취약점 스캐닝을 CI에 통합하세요.
