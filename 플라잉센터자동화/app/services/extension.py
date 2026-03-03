"""Automatic extension order generation for overdue luggage orders."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.config import JST
from app.services.order_number import build_order_id
from app.supabase_client import SupabaseDB
from app.utils import utc_now

logger = logging.getLogger("flying-center")


def generate_extension_orders(db: SupabaseDB) -> dict[str, int]:
    """Find overdue root orders and create extension order lines.

    Returns dict with counts: {"created": N, "skipped_dup": N}
    """
    now = utc_now()
    today_jst = now.astimezone(JST).date()
    today_str = today_jst.strftime("%Y-%m-%d")

    # 1. Find overdue root orders (not picked up, past expected pickup, no parent)
    overdue = (
        db.query("orders")
        .filter(
            ("status", "IN", ["PAID", "PAYMENT_PENDING"]),
            ("expected_pickup_at", "<", now.isoformat()),
            ("parent_order_id", "IS NULL"),
        )
        .all()
    )

    if not overdue:
        return {"created": 0, "skipped_dup": 0}

    # 2. Collect root order IDs for dedup check
    root_ids = [o.order_id for o in overdue]

    # Find existing extensions created today for these roots
    existing_extensions = (
        db.query("orders")
        .filter(
            ("parent_order_id", "IN", root_ids),
        )
        .all()
    )

    # Build set of (parent_order_id, business_date) pairs already covered
    already_extended: set[tuple[str, str]] = set()
    for ext in existing_extensions:
        ext_date = datetime.fromisoformat(ext.created_at).astimezone(JST).date().strftime("%Y-%m-%d") if isinstance(ext.created_at, str) else ext.created_at.astimezone(JST).date().strftime("%Y-%m-%d")
        already_extended.add((ext.parent_order_id, ext_date))

    created = 0
    skipped_dup = 0

    for order in overdue:
        # Dedup: skip if extension already exists for this root on today's date
        if (order.order_id, today_str) in already_extended:
            skipped_dup += 1
            continue

        # Build extension order
        ext_order_id = f"EXT-{build_order_id(db, now)}"
        price_per_day = int(order.price_per_day or 0)

        # expected_pickup_at = today 21:00 JST
        pickup_jst = datetime(
            today_jst.year, today_jst.month, today_jst.day,
            21, 0, 0, tzinfo=JST,
        )
        pickup_utc = pickup_jst.astimezone(timezone.utc)

        db.insert("orders", {
            "order_id": ext_order_id,
            "created_at": now,
            "name": order.name,
            "phone": order.phone,
            "companion_count": 0,
            "suitcase_qty": order.suitcase_qty,
            "backpack_qty": order.backpack_qty,
            "set_qty": order.set_qty,
            "expected_pickup_at": pickup_utc,
            "expected_storage_days": 1,
            "actual_storage_days": None,
            "extra_days": 0,
            "price_per_day": price_per_day,
            "discount_rate": 0,
            "prepaid_amount": price_per_day,
            "flying_pass_tier": "NONE",
            "flying_pass_discount_amount": 0,
            "staff_prepaid_override_amount": None,
            "extra_amount": 0,
            "final_amount": price_per_day,
            "payment_method": None,
            "status": "PAYMENT_PENDING",
            "tag_no": order.tag_no or "",
            "note": f"자동연장 ({order.order_id})",
            "id_image_url": "",
            "luggage_image_url": "",
            "consent_checked": True,
            "manual_entry": False,
            "staff_id": None,
            "parent_order_id": order.order_id,
            "in_warehouse": bool(getattr(order, "in_warehouse", False)),
        })
        created += 1

    result = {"created": created, "skipped_dup": skipped_dup}
    logger.info("Extension orders generated: %s", result)
    return result
