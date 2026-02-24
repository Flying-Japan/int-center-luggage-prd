"""
E2E tests for the Flying Japan luggage storage app.
Runs inside Docker container against http://localhost:8000.
Creates a temporary test user via Supabase Admin API, runs all tests, then cleans up.
"""
import os
import sys
import uuid
import json
from datetime import datetime, timezone

import httpx
from supabase import create_client

BASE = "http://localhost:8000"
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

TEST_EMAIL = f"e2e-test-{uuid.uuid4().hex[:8]}@test.local"
TEST_PASSWORD = "E2eTestPass#9999"

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"

results = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = PASS if condition else FAIL
    msg = f"  [{status}] {label}"
    if detail:
        msg += f"  ({detail})"
    print(msg)
    results.append((label, condition))
    if not condition:
        print(f"         ^^^ FAILED")


def setup_test_user(admin_client) -> str:
    """Create a test user in Supabase Auth + user_profiles. Returns user_id."""
    print("\n[Setup] Creating temporary test user...")
    response = admin_client.auth.admin.create_user({
        "email": TEST_EMAIL,
        "password": TEST_PASSWORD,
        "email_confirm": True,
    })
    user_id = response.user.id
    # Upsert into user_profiles (handles re-runs where Auth user exists but profile doesn't)
    admin_client.table("user_profiles").upsert({
        "id": str(user_id),
        "username": TEST_EMAIL,
        "display_name": "E2E Test User",
        "role": "admin",
        "is_active": True,
        "email": TEST_EMAIL,
    }).execute()
    print(f"  Created: {TEST_EMAIL} (id={user_id})")
    return str(user_id)


def teardown_test_user(admin_client, user_id: str) -> None:
    """Remove test user from user_profiles and Supabase Auth."""
    print("\n[Teardown] Removing temporary test user...")
    try:
        admin_client.table("user_profiles").delete().eq("id", user_id).execute()
        admin_client.auth.admin.delete_user(user_id)
        print(f"  Deleted: {TEST_EMAIL}")
    except Exception as e:
        print(f"  WARNING: cleanup failed: {e}")


def run_tests(admin_client, user_id: str) -> None:
    print("\n=== Unauthenticated Routes ===")
    with httpx.Client(base_url=BASE, follow_redirects=False) as c:
        r = c.get("/customer")
        check("GET /customer → 200", r.status_code == 200)

        r = c.get("/staff/login")
        check("GET /staff/login → 200", r.status_code == 200)

        r = c.get("/staff/dashboard")
        check("GET /staff/dashboard (no session) → 303", r.status_code == 303)
        check("  redirects to /staff/login", r.headers.get("location", "").endswith("/staff/login"))

        r = c.get("/staff/api/orders")
        check("GET /staff/api/orders (no session) → 303", r.status_code == 303)

    print("\n=== Customer Order Submission ===")
    with httpx.Client(base_url=BASE, follow_redirects=False) as c:
        # Pick up tomorrow at 10:00 JST (naive string — server treats it as JST)
        from datetime import date, timedelta
        tomorrow = date.today() + timedelta(days=1)
        pickup_str = f"{tomorrow}T10:00"
        # Minimal 1-pixel PNG bytes for required image uploads
        tiny_png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00"
            b"\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        r = c.post(
            "/customer/submit",
            data={
                "name": "E2E Test Customer",
                "phone": "090-1234-5678",
                "companion_count": "2",
                "payment_method": "CASH",
                "suitcase_qty": "1",
                "backpack_qty": "1",
                "expected_pickup_at": pickup_str,
                "consent_checked": "on",
                "lang": "ko",
            },
            files={
                "id_image": ("id.png", tiny_png, "image/png"),
                "luggage_image": ("luggage.png", tiny_png, "image/png"),
            },
        )
        check(
            "POST /customer/submit → 200 or 303",
            r.status_code in (200, 303),
            f"status={r.status_code}",
        )
        if r.status_code == 303:
            location = r.headers.get("location", "")
            check("  redirects to confirmation page", "/customer/orders/" in location, detail=location)

    print("\n=== Staff Login / Session ===")
    with httpx.Client(base_url=BASE, follow_redirects=False) as c:
        # Bad credentials
        r = c.post("/staff/login", data={"email": TEST_EMAIL, "password": "wrongpassword"})
        check("POST /staff/login (bad password) → 401", r.status_code == 401, f"status={r.status_code}")

        # Correct credentials
        r = c.post("/staff/login", data={"email": TEST_EMAIL, "password": TEST_PASSWORD})
        check("POST /staff/login (correct) → 303", r.status_code == 303, f"status={r.status_code}")
        check("  redirects to /staff/dashboard", "/staff/dashboard" in r.headers.get("location", ""))

        # Follow redirect — carry session cookie
        session_cookie = r.headers.get("set-cookie", "")
        cookies = {}
        for part in session_cookie.split(";"):
            part = part.strip()
            if "=" in part and not part.startswith(("Path", "HttpOnly", "Secure", "SameSite", "Max-Age", "Expires")):
                k, v = part.split("=", 1)
                cookies[k.strip()] = v.strip()

        r2 = c.get("/staff/dashboard", cookies=cookies)
        check("GET /staff/dashboard (with session) → 200", r2.status_code == 200, f"status={r2.status_code}")

        # Staff orders API
        r3 = c.get("/staff/api/orders", cookies=cookies)
        check("GET /staff/api/orders (with session) → 200", r3.status_code == 200, f"status={r3.status_code}")

        # Admin-only page
        r4 = c.get("/staff/admin/staff-accounts", cookies=cookies)
        check("GET /staff/admin/staff-accounts (admin role) → 200", r4.status_code == 200, f"status={r4.status_code}")

        # Logout
        r5 = c.get("/staff/logout", cookies=cookies)
        check("GET /staff/logout → 303 to /staff/login", r5.status_code == 303 and "/staff/login" in r5.headers.get("location", ""))

        # After logout, dashboard should redirect
        r6 = c.get("/staff/dashboard")
        check("GET /staff/dashboard (after logout) → 303", r6.status_code == 303)

    print("\n=== Supabase Table Connectivity ===")
    from app.supabase_client import SupabaseDB
    db = SupabaseDB(url=SUPABASE_URL, service_role_key=SUPABASE_KEY)
    try:
        rows = db.query("orders").limit(5).all()
        check("luggage_orders readable", True, f"count={len(rows)}")

        profiles = db.query("user_profiles").limit(5).all()
        check("user_profiles readable", len(profiles) > 0, f"count={len(profiles)}")

        # Counter tables
        counters = db.query("daily_counters").limit(1).all()
        check("luggage_daily_counters readable", True, f"count={len(counters)}")
    except Exception as e:
        check("Supabase tables readable", False, str(e))
    finally:
        db.close()


def main() -> None:
    print("=" * 60)
    print("Flying Japan Luggage App — E2E Test Suite")
    print("=" * 60)

    admin_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    user_id = setup_test_user(admin_client)

    try:
        run_tests(admin_client, user_id)
    finally:
        teardown_test_user(admin_client, user_id)

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    if failed > 0:
        print("\nFailed tests:")
        for label, ok in results:
            if not ok:
                print(f"  - {label}")
        sys.exit(1)


if __name__ == "__main__":
    main()
