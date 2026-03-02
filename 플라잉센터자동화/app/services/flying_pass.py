"""Flying Pass tier logic: normalization, discounts, and order recalculation."""
from __future__ import annotations

from typing import Optional

from app.services.pricing import calculate_prepaid_amount


FLYING_PASS_TIERS = ("NONE", "BLUE", "SILVER", "GOLD", "PLATINUM", "BLACK")
FLYING_PASS_FIXED_DISCOUNTS = {
    "NONE": 0,
    "BLUE": 100,
    "SILVER": 200,
    "GOLD": 300,
    "PLATINUM": 400,
    "BLACK": 0,
}


FLYING_PASS_TIER_LABELS = {
    "NONE": "미적용",
    "BLUE": "블루",
    "SILVER": "실버",
    "GOLD": "골드",
    "PLATINUM": "플래티넘",
    "BLACK": "블랙",
}


def build_flying_pass_tiers_json() -> list[dict[str, object]]:
    """Build tier data list for frontend consumption (single source of truth)."""
    return [
        {
            "value": tier,
            "label": FLYING_PASS_TIER_LABELS.get(tier, tier),
            "discount": FLYING_PASS_FIXED_DISCOUNTS.get(tier, 0),
        }
        for tier in FLYING_PASS_TIERS
    ]


def normalize_flying_pass_tier(raw_value: object, default: str = "NONE") -> str:
    value = str(raw_value or "").strip().upper()
    if value in FLYING_PASS_TIERS:
        return value
    return default


def flying_pass_discount_amount(base_prepaid: int, tier: str) -> int:
    resolved_base = max(int(base_prepaid or 0), 0)
    normalized_tier = normalize_flying_pass_tier(tier)
    if normalized_tier == "BLACK":
        return resolved_base
    fixed_discount = int(FLYING_PASS_FIXED_DISCOUNTS.get(normalized_tier, 0))
    return min(resolved_base, max(fixed_discount, 0))


def recalculate_order_prepaid(
    order,
    *,
    expected_storage_days: Optional[int] = None,
    flying_pass_tier: Optional[str] = None,
    submitted_prepaid_amount: Optional[int] = None,
) -> dict[str, object]:
    resolved_days = int(expected_storage_days if expected_storage_days is not None else order.expected_storage_days or 1)
    if resolved_days < 1:
        resolved_days = 1

    resolved_tier = normalize_flying_pass_tier(
        flying_pass_tier if flying_pass_tier is not None else order.flying_pass_tier
    )
    discount_rate, base_prepaid = calculate_prepaid_amount(order.price_per_day, resolved_days)
    member_discount = flying_pass_discount_amount(base_prepaid, resolved_tier)
    auto_prepaid = max(int(base_prepaid) - member_discount, 0)

    if submitted_prepaid_amount is None:
        if order.staff_prepaid_override_amount is None:
            resolved_prepaid = auto_prepaid
            override_amount = None
        else:
            resolved_prepaid = max(int(order.staff_prepaid_override_amount), 0)
            override_amount = resolved_prepaid if resolved_prepaid != auto_prepaid else None
    else:
        resolved_prepaid = max(int(submitted_prepaid_amount), 0)
        override_amount = resolved_prepaid if resolved_prepaid != auto_prepaid else None

    order.expected_storage_days = resolved_days
    order.discount_rate = discount_rate
    order.flying_pass_tier = resolved_tier
    order.flying_pass_discount_amount = member_discount
    order.staff_prepaid_override_amount = override_amount
    order.prepaid_amount = resolved_prepaid
    order.final_amount = resolved_prepaid + int(order.extra_amount or 0)

    return {
        "expected_storage_days": resolved_days,
        "discount_rate": discount_rate,
        "base_prepaid_amount": int(base_prepaid),
        "flying_pass_tier": resolved_tier,
        "flying_pass_discount_amount": member_discount,
        "auto_prepaid_amount": auto_prepaid,
        "prepaid_amount": resolved_prepaid,
        "staff_prepaid_override_amount": override_amount,
    }
