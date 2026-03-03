"""
E2E tests for staff dashboard button functions.
Tests: toggle-warehouse, cancel, bulk-action, payment toggle, pickup, undo-pickup, inline-update.
Runs against the production server using a temporary test user + test order.
"""
import os
import sys
import uuid
import json
from datetime import datetime, timezone, timedelta

import httpx
from supabase import create_client

BASE = os.environ.get("E2E_BASE_URL", "https://luggage.flyingjp.com")
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

TEST_EMAIL = f"e2e-btn-{uuid.uuid4().hex[:8]}@test.local"
TEST_PASSWORD = "E2eBtnTest#9999"

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
    print("\n[Setup] Creating temporary test user...")
    response = admin_client.auth.admin.create_user({
        "email": TEST_EMAIL,
        "password": TEST_PASSWORD,
        "email_confirm": True,
    })
    user_id = response.user.id
    admin_client.table("user_profiles").upsert({
        "id": str(user_id),
        "username": TEST_EMAIL,
        "display_name": "E2E Button Test User",
        "role": "admin",
        "is_active": True,
        "email": TEST_EMAIL,
    }).execute()
    print(f"  Created: {TEST_EMAIL} (id={user_id})")
    return str(user_id)


def create_test_order(admin_client) -> str:
    """Create a test order directly in DB. Returns order_id."""
    now = datetime.now(timezone.utc)
    pickup = now + timedelta(hours=3)
    order_id = f"E2E-BTN-{uuid.uuid4().hex[:8]}"
    admin_client.table("luggage_orders").insert({
        "order_id": order_id,
        "name": "E2E Button Test",
        "phone": "090-0000-0000",
        "companion_count": 0,
        "suitcase_qty": 1,
        "backpack_qty": 0,
        "set_qty": 0,
        "payment_method": "PAY_QR",
        "expected_pickup_at": pickup.isoformat(),
        "expected_storage_days": 1,
        "price_per_day": 800,
        "prepaid_amount": 800,
        "status": "PAYMENT_PENDING",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "in_warehouse": False,
    }).execute()
    print(f"  Created test order: {order_id}")
    return order_id


def create_second_test_order(admin_client) -> str:
    """Create a second test order for bulk actions."""
    now = datetime.now(timezone.utc)
    pickup = now + timedelta(hours=3)
    order_id = f"E2E-BLK-{uuid.uuid4().hex[:8]}"
    admin_client.table("luggage_orders").insert({
        "order_id": order_id,
        "name": "E2E Bulk Test",
        "phone": "090-0000-0001",
        "companion_count": 0,
        "suitcase_qty": 1,
        "backpack_qty": 0,
        "set_qty": 0,
        "payment_method": "PAY_QR",
        "expected_pickup_at": pickup.isoformat(),
        "expected_storage_days": 1,
        "price_per_day": 800,
        "prepaid_amount": 800,
        "status": "PAYMENT_PENDING",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "in_warehouse": False,
    }).execute()
    print(f"  Created test order: {order_id}")
    return order_id


def teardown(admin_client, user_id: str, order_ids: list[str]) -> None:
    print("\n[Teardown] Cleaning up...")
    for oid in order_ids:
        try:
            admin_client.table("luggage_orders").delete().eq("order_id", oid).execute()
            print(f"  Deleted order: {oid}")
        except Exception as e:
            print(f"  WARNING: failed to delete order {oid}: {e}")
    try:
        admin_client.table("user_profiles").delete().eq("id", user_id).execute()
        admin_client.auth.admin.delete_user(user_id)
        print(f"  Deleted user: {TEST_EMAIL}")
    except Exception as e:
        print(f"  WARNING: cleanup failed: {e}")


def staff_login(client: httpx.Client) -> dict:
    """Login and return cookies dict."""
    r = client.post("/staff/login", data={"email": TEST_EMAIL, "password": TEST_PASSWORD})
    if r.status_code != 303:
        print(f"  Login failed: status={r.status_code}")
        try:
            print(f"  Body: {r.text[:500]}")
        except:
            pass
        return {}
    cookies = {}
    for header_val in r.headers.get_list("set-cookie"):
        for part in header_val.split(";"):
            part = part.strip()
            if "=" in part and not part.startswith(
                ("Path", "HttpOnly", "Secure", "SameSite", "Max-Age", "Expires", "path", "httponly", "secure")
            ):
                k, v = part.split("=", 1)
                cookies[k.strip()] = v.strip()
    return cookies


def run_tests(admin_client, user_id: str) -> None:
    order_ids = []

    # Create test orders
    print("\n[Setup] Creating test orders...")
    order_id1 = create_test_order(admin_client)
    order_id2 = create_second_test_order(admin_client)
    order_ids.extend([order_id1, order_id2])

    try:
        _run_all_button_tests(admin_client, user_id, order_id1, order_id2)
    finally:
        teardown(admin_client, user_id, order_ids)


def _run_all_button_tests(admin_client, user_id, order_id1, order_id2):
    print("\n=== Staff Login ===")
    with httpx.Client(base_url=BASE, follow_redirects=False, timeout=15.0) as c:
        cookies = staff_login(c)
        check("Staff login successful", bool(cookies), f"cookies={list(cookies.keys())}")
        if not cookies:
            print("  Cannot proceed without login session")
            return

        # ── Test 1: GET /staff/api/orders ──
        print("\n=== 1. Fetch Orders API ===")
        r = c.get("/staff/api/orders", cookies=cookies, params={"status_filter": ["PAYMENT_PENDING", "PAID", "PICKED_UP", "CANCELLED"]})
        check("GET /staff/api/orders → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  Response has 'orders' key", "orders" in data)
            orders = data.get("orders", [])
            check("  Orders is a list", isinstance(orders, list), f"count={len(orders)}")
            # Find our test order
            test_order = next((o for o in orders if o.get("order_id") == order_id1), None)
            if test_order:
                check("  Test order found in results", True)
                check("  Has 'in_warehouse' field", "in_warehouse" in test_order, f"keys={list(test_order.keys())}")
                check("  Has 'is_cancelled' field", "is_cancelled" in test_order)
                check("  Has 'needs_extra_payment' field", "needs_extra_payment" in test_order)
            else:
                check("  Test order found in results", False, "Order not in API response")
        else:
            try:
                print(f"  Response body: {r.text[:500]}")
            except:
                pass

        # ── Test 2: Toggle Warehouse ──
        print("\n=== 2. Toggle Warehouse ===")
        r = c.post(f"/staff/api/orders/{order_id1}/toggle-warehouse", cookies=cookies)
        check("POST toggle-warehouse → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            order_data = data.get("order", {})
            check("  in_warehouse is True after toggle", order_data.get("in_warehouse") is True, f"in_warehouse={order_data.get('in_warehouse')}")

            # Toggle back
            r2 = c.post(f"/staff/api/orders/{order_id1}/toggle-warehouse", cookies=cookies)
            check("  Toggle back → 200", r2.status_code == 200)
            if r2.status_code == 200:
                order_data2 = r2.json().get("order", {})
                check("  in_warehouse is False after second toggle", order_data2.get("in_warehouse") is False, f"in_warehouse={order_data2.get('in_warehouse')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 3: Inline Update (save row) ──
        print("\n=== 3. Inline Update ===")
        from datetime import date
        tomorrow = date.today() + timedelta(days=1)
        payload = {
            "name": "E2E Updated Name",
            "tag_no": "A15",
            "prepaid_amount": "800",
            "flying_pass_tier": "NONE",
            "payment_method": "PAY_QR",
            "payment_status": "PAID",
            "expected_pickup_at": f"{tomorrow}T14:00",
            "note": "test note",
        }
        r = c.post(
            f"/staff/api/orders/{order_id1}/inline-update",
            cookies=cookies,
            json=payload,
        )
        check("POST inline-update → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            order_data = data.get("order", {})
            check("  Name updated", order_data.get("name") == "E2E Updated Name", f"name={order_data.get('name')}")
            check("  Tag updated", order_data.get("tag_no") == "A15", f"tag_no={order_data.get('tag_no')}")
            check("  Payment status is PAID", order_data.get("payment_status") == "PAID", f"ps={order_data.get('payment_status')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 4: Toggle Payment Status (PAID → PAYMENT_PENDING via inline-update) ──
        print("\n=== 4. Payment Status Toggle ===")
        payload2 = {**payload, "payment_status": "PAYMENT_PENDING"}
        r = c.post(
            f"/staff/api/orders/{order_id1}/inline-update",
            cookies=cookies,
            json=payload2,
        )
        check("POST inline-update (toggle to PENDING) → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            order_data = r.json().get("order", {})
            check("  Payment status is PAYMENT_PENDING", order_data.get("payment_status") == "PAYMENT_PENDING", f"ps={order_data.get('payment_status')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # Set back to PAID for pickup test
        payload_paid = {**payload, "payment_status": "PAID"}
        c.post(f"/staff/api/orders/{order_id1}/inline-update", cookies=cookies, json=payload_paid)

        # ── Test 5: Pickup (수령완료) ──
        print("\n=== 5. Pickup (수령완료) ===")
        r = c.post(f"/staff/api/orders/{order_id1}/pickup", cookies=cookies)
        check("POST pickup → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            order_data = r.json().get("order", {})
            check("  is_picked_up is True", order_data.get("is_picked_up") is True, f"is_picked_up={order_data.get('is_picked_up')}")
            check("  payment_status still PAID", order_data.get("payment_status") == "PAID")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 6: Undo Pickup (수령취소) ──
        print("\n=== 6. Undo Pickup (수령취소) ===")
        r = c.post(f"/staff/api/orders/{order_id1}/undo-pickup", cookies=cookies)
        check("POST undo-pickup → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            order_data = r.json().get("order", {})
            check("  is_picked_up is False", order_data.get("is_picked_up") is False, f"is_picked_up={order_data.get('is_picked_up')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 7: Cancel Order (삭제) ──
        print("\n=== 7. Cancel Order (삭제) ===")
        r = c.post(f"/staff/api/orders/{order_id1}/cancel", cookies=cookies)
        check("POST cancel → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            order_data = r.json().get("order", {})
            check("  is_cancelled is True", order_data.get("is_cancelled") is True, f"is_cancelled={order_data.get('is_cancelled')}")
            check("  payment_status is CANCELLED", order_data.get("payment_status") == "CANCELLED", f"ps={order_data.get('payment_status')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 8: Cancel picked-up order should fail ──
        print("\n=== 8. Cancel Picked-Up Order (should fail) ===")
        # First set order2 to PAID and pickup
        payload_o2 = {
            "name": "E2E Bulk Test",
            "tag_no": "",
            "prepaid_amount": "800",
            "flying_pass_tier": "NONE",
            "payment_method": "PAY_QR",
            "payment_status": "PAID",
            "expected_pickup_at": f"{tomorrow}T14:00",
            "note": "",
        }
        c.post(f"/staff/api/orders/{order_id2}/inline-update", cookies=cookies, json=payload_o2)
        c.post(f"/staff/api/orders/{order_id2}/pickup", cookies=cookies)
        r = c.post(f"/staff/api/orders/{order_id2}/cancel", cookies=cookies)
        check("POST cancel picked-up → 400", r.status_code == 400, f"status={r.status_code}")

        # Undo pickup for bulk tests
        c.post(f"/staff/api/orders/{order_id2}/undo-pickup", cookies=cookies)

        # ── Test 9: Bulk Action - warehouse_on ──
        print("\n=== 9. Bulk Action - warehouse_on ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "warehouse_on"},
        )
        check("POST bulk-action warehouse_on → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  updated count = 1", data.get("updated") == 1, f"updated={data.get('updated')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 10: Bulk Action - warehouse_off ──
        print("\n=== 10. Bulk Action - warehouse_off ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "warehouse_off"},
        )
        check("POST bulk-action warehouse_off → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  updated count = 1", data.get("updated") == 1, f"updated={data.get('updated')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 11: Bulk Action - set_paid ──
        print("\n=== 11. Bulk Action - set_paid ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "set_paid"},
        )
        check("POST bulk-action set_paid → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  updated count = 1", data.get("updated") == 1, f"updated={data.get('updated')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 12: Bulk Action - set_pending ──
        print("\n=== 12. Bulk Action - set_pending ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "set_pending"},
        )
        check("POST bulk-action set_pending → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  updated count = 1", data.get("updated") == 1, f"updated={data.get('updated')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 13: Bulk Action - cancel ──
        print("\n=== 13. Bulk Action - cancel ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "cancel"},
        )
        check("POST bulk-action cancel → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            check("  updated count = 1", data.get("updated") == 1, f"updated={data.get('updated')}")
        else:
            try:
                print(f"  Error: {r.text[:500]}")
            except:
                pass

        # ── Test 14: Bulk Action - invalid action ──
        print("\n=== 14. Bulk Action - invalid action ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [order_id2], "action": "invalid_action"},
        )
        check("POST bulk-action invalid → 400", r.status_code == 400, f"status={r.status_code}")

        # ── Test 15: Bulk Action - no order_ids ──
        print("\n=== 15. Bulk Action - empty order_ids ===")
        r = c.post(
            "/staff/api/orders/bulk-action",
            cookies=cookies,
            json={"order_ids": [], "action": "set_paid"},
        )
        check("POST bulk-action empty ids → 400", r.status_code == 400, f"status={r.status_code}")

        # ── Test 16: Toggle warehouse on non-existent order ──
        print("\n=== 16. Non-existent Order ===")
        r = c.post("/staff/api/orders/NONEXISTENT-999/toggle-warehouse", cookies=cookies)
        check("POST toggle-warehouse non-existent → 404", r.status_code == 404, f"status={r.status_code}")

        r = c.post("/staff/api/orders/NONEXISTENT-999/cancel", cookies=cookies)
        check("POST cancel non-existent → 404", r.status_code == 404, f"status={r.status_code}")

        # ── Test 17: Verify CANCELLED status filter ──
        print("\n=== 17. CANCELLED Status Filter ===")
        r = c.get("/staff/api/orders", cookies=cookies, params={"status_filter": "CANCELLED"})
        check("GET orders with CANCELLED filter → 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            orders = r.json().get("orders", [])
            cancelled_order = next((o for o in orders if o.get("order_id") == order_id1), None)
            check("  Cancelled order appears in results", cancelled_order is not None)
            if cancelled_order:
                check("  is_cancelled=True", cancelled_order.get("is_cancelled") is True)


def main() -> None:
    print("=" * 60)
    print("Flying Japan — Button Functions E2E Test Suite")
    print(f"Target: {BASE}")
    print("=" * 60)

    admin_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    user_id = setup_test_user(admin_client)

    try:
        run_tests(admin_client, user_id)
    except Exception as e:
        print(f"\n[FATAL ERROR] {e}")
        import traceback
        traceback.print_exc()
        # Still try to clean up
        try:
            teardown(admin_client, user_id, [])
        except:
            pass
        sys.exit(2)

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    print(f"Results: {passed} passed, {failed} failed, {len(results)} total")
    print("=" * 60)

    if failed > 0:
        print("\nFailed tests:")
        for label, ok in results:
            if not ok:
                print(f"  - {label}")
        sys.exit(1)
    else:
        print("\nAll tests passed!")


if __name__ == "__main__":
    main()
