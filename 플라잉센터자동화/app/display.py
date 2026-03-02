"""Display/label helper functions for UI rendering."""
from __future__ import annotations

from typing import Optional


def display_payment_method(payment_method: Optional[str]) -> str:
    if not payment_method:
        return "-"
    mapping = {
        "PAY_QR": "QR결제",
        "CASH": "현금",
    }
    return mapping.get(payment_method, payment_method)


def display_flying_pass_tier(tier: str) -> str:
    from app.services.flying_pass import normalize_flying_pass_tier

    mapping = {
        "NONE": "미적용",
        "BLUE": "블루",
        "SILVER": "실버",
        "GOLD": "골드",
        "PLATINUM": "플래티넘",
        "BLACK": "블랙",
    }
    normalized_tier = normalize_flying_pass_tier(tier)
    return mapping.get(normalized_tier, normalized_tier)


def display_lost_found_status(status_value: str) -> str:
    mapping = {
        "STORED": "보관중",
        "RETURNED": "인계완료",
        "DISPOSED": "폐기",
    }
    return mapping.get(status_value, status_value)


def display_note_category(category: str) -> str:
    mapping = {
        "NOTICE": "안내사항",
        "HANDOVER": "인수인계",
    }
    return mapping.get(category, category)


def display_cash_closing_type(closing_type: str) -> str:
    mapping = {
        "MORNING_HANDOVER": "오전 인수인계",
        "FINAL_CLOSE": "최종 마감",
    }
    return mapping.get(closing_type, closing_type)


def display_cash_closing_status(status_value: str) -> str:
    mapping = {
        "DRAFT": "작성중",
        "SUBMITTED": "제출됨",
        "LOCKED": "확인완료(잠금)",
    }
    return mapping.get(status_value, status_value)


def cash_closing_status_pill_class(status_value: str) -> str:
    mapping = {
        "DRAFT": "status-payment_pending",
        "SUBMITTED": "status-picked_up",
        "LOCKED": "status-paid",
    }
    return mapping.get(status_value, "status-payment_pending")


def display_cash_closing_audit_action(action: str) -> str:
    mapping = {
        "CREATE": "등록",
        "UPDATE": "수정",
        "ADMIN_UNLOCK_UPDATE": "잠금해제수정",
        "SUBMIT": "제출",
        "VERIFY_LOCK": "확인잠금",
    }
    return mapping.get(action, action)
