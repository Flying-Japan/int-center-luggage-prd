"""Automatic extension order generation for overdue luggage orders."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.config import JST
from app.services.order_number import build_order_id
from app.supabase_client import SupabaseDB
from app.utils import utc_now, ensure_utc_datetime

logger = logging.getLogger("flying-center")


def build_extension_order_record(
    db: SupabaseDB,
    parent_order,
    *,
    root_id: str,
    note: str,
    staff_id: Optional[str] = None,
) -> dict:
    """Build an extension order dict from a parent order."""
    now = utc_now()
    today_jst = now.astimezone(JST).date()
    pickup_jst = datetime(
        today_jst.year, today_jst.month, today_jst.day,
        21, 0, 0, tzinfo=JST,
    )
    pickup_utc = pickup_jst.astimezone(timezone.utc)
    price_per_day = int(parent_order.price_per_day or 0)

    return {
        "order_id": f"EXT-{build_order_id(db, now)}",
        "created_at": now,
        "name": parent_order.name,
        "phone": parent_order.phone,
        "companion_count": 0,
        "suitcase_qty": parent_order.suitcase_qty,
        "backpack_qty": parent_order.backpack_qty,
        "set_qty": parent_order.set_qty,
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
        "tag_no": parent_order.tag_no or "",
        "note": note,
        "id_image_url": "",
        "luggage_image_url": "",
        "consent_checked": True,
        "manual_entry": False,
        "staff_id": staff_id,
        "parent_order_id": root_id,
        "in_warehouse": bool(getattr(parent_order, "in_warehouse", False)),
    }


def generate_extension_orders(db: SupabaseDB) -> dict[str, int]:
    """Find overdue root orders and create extension order lines.

    Returns dict with counts: {"created": N, "skipped_dup": N}
    """
    now = utc_now()
    today_jst = now.astimezone(JST).date()

    # 1. Find overdue root orders (not picked up, past expected pickup, no parent)
    overdue = (
        db.query("orders")
        .filter(
            ("status", "IN", ["PAID", "PAYMENT_PENDING"]),
            ("expected_pickup_at", "<", now.isoformat()),
            ("parent_order_id", "IS NULL", None),
        )
        .all()
    )

    if not overdue:
        return {"created": 0, "skipped_dup": 0}

    # 2. Dedup: find extensions already created today for these roots
    root_ids = [o.order_id for o in overdue]
    today_start_utc = datetime(
        today_jst.year, today_jst.month, today_jst.day, tzinfo=JST,
    ).astimezone(timezone.utc)
    tomorrow_start_utc = today_start_utc + timedelta(days=1)

    existing_today = (
        db.query("orders")
        .filter(
            ("parent_order_id", "IN", root_ids),
            ("created_at", ">=", today_start_utc.isoformat()),
            ("created_at", "<", tomorrow_start_utc.isoformat()),
        )
        .all()
    )
    already_extended = {ext.parent_order_id for ext in existing_today}

    created = 0
    skipped_dup = 0

    for order in overdue:
        if order.order_id in already_extended:
            skipped_dup += 1
            continue

        record = build_extension_order_record(
            db, order,
            root_id=order.order_id,
            note=f"자동연장 ({order.order_id})",
        )
        db.insert("orders", record)
        created += 1

    result = {"created": created, "skipped_dup": skipped_dup}
    logger.info("Extension orders generated: %s", result)
    return result
