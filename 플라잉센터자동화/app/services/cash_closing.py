"""Cash closing helpers: denomination parsing, totals, auditing, and field computation."""
from __future__ import annotations

import json
from typing import Optional

from fastapi import HTTPException

from app.supabase_client import SupabaseDB
from app.utils import utc_now


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COIN_BILL_DENOMS = (10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1)
CASH_CLOSING_TYPES = ("MORNING_HANDOVER", "FINAL_CLOSE")
CASH_CLOSING_STATUSES = ("DRAFT", "SUBMITTED", "LOCKED")


# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

def parse_cash_closing_type(raw_value: str) -> str:
    value = (raw_value or "").strip().upper()
    if value not in CASH_CLOSING_TYPES:
        raise HTTPException(status_code=400, detail="Invalid cash closing type.")
    return value


def ensure_unique_cash_closing_type(
    db: SupabaseDB,
    business_date: str,
    closing_type: str,
    *,
    exclude_closing_id: Optional[int] = None,
) -> None:
    q = db.query("cash_closings").filter(
        ("business_date", "=", business_date),
        ("closing_type", "=", closing_type),
    )
    if exclude_closing_id:
        q = q.filter(("closing_id", "!=", exclude_closing_id))
    exists = q.first()
    if exists:
        raise HTTPException(
            status_code=400,
            detail=f"해당 날짜({business_date})의 {closing_type} 정산이 이미 존재합니다.",
        )


def create_cash_closing_audit(
    db: SupabaseDB,
    row,
    *,
    action: str,
    staff_id: int,
    reason: str = "",
    payload: dict | None = None,
) -> None:
    db.insert("cash_closing_audits", {
        "closing_id": row.closing_id,
        "action": action,
        "reason": reason.strip() or None,
        "payload": json.dumps(payload, ensure_ascii=False) if payload else None,
        "staff_id": staff_id,
        "created_at": utc_now(),
    })


def calc_cash_total(counts_by_denom: dict[int, int]) -> int:
    return sum(denom * counts_by_denom.get(denom, 0) for denom in COIN_BILL_DENOMS)


def parse_denomination_counts(
    count_10000: int,
    count_5000: int,
    count_2000: int,
    count_1000: int,
    count_500: int,
    count_100: int,
    count_50: int,
    count_10: int,
    count_5: int,
    count_1: int,
) -> dict[int, int]:
    counts = {
        10000: count_10000,
        5000: count_5000,
        2000: count_2000,
        1000: count_1000,
        500: count_500,
        100: count_100,
        50: count_50,
        10: count_10,
        5: count_5,
        1: count_1,
    }
    if any(value < 0 for value in counts.values()):
        raise HTTPException(status_code=400, detail="Bill/Coin counts must be non-negative.")
    return counts


def parse_actual_qr_amount(raw_value: int, auto_qr_amount: int) -> int:
    if raw_value < 0:
        return auto_qr_amount
    return raw_value


# ---------------------------------------------------------------------------
# Task 7: Deduplicated helper for cash closing create/update
# ---------------------------------------------------------------------------

def build_cash_closing_fields(
    counts: dict[int, int],
    actual_qr_amount: int,
    db: SupabaseDB,
    business_date: str,
) -> dict[str, object]:
    """Compute the shared denomination-total and difference fields.

    Used by both ``staff_cash_closing_create`` and ``staff_cash_closing_update``
    to avoid duplicating the computation logic.

    Returns a dict with keys that can be applied directly to a cash_closings
    insert payload or row update.
    """
    from app.services.sales import summarize_order_sales_for_date

    total_amount = calc_cash_total(counts)
    sales = summarize_order_sales_for_date(db, business_date)
    auto_paypay = sales["qr_amount"]
    resolved_actual_qr = parse_actual_qr_amount(actual_qr_amount, auto_paypay)
    if resolved_actual_qr < 0:
        raise HTTPException(status_code=400, detail="QR actual amount must be non-negative.")
    qr_difference_amount = resolved_actual_qr - auto_paypay
    check_auto_amount = sales["cash_amount"]
    difference_amount = total_amount - check_auto_amount

    return {
        "total_amount": total_amount,
        "paypay_amount": auto_paypay,
        "actual_qr_amount": resolved_actual_qr,
        "qr_difference_amount": qr_difference_amount,
        "check_auto_amount": check_auto_amount,
        "expected_amount": check_auto_amount,
        "actual_amount": total_amount,
        "difference_amount": difference_amount,
    }
