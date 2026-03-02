"""Datetime/utility helpers — pure functions with no HTTP framework dependency."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.config import JST


def format_yen(value: object) -> str:
    try:
        amount = int(float(value or 0))
    except (TypeError, ValueError):
        amount = 0
    return f"¥ {amount:,}"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc_datetime(dt) -> datetime:
    # Supabase REST API returns TIMESTAMPTZ columns as ISO 8601 strings
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_jst_datetime(dt: datetime) -> datetime:
    return ensure_utc_datetime(dt).astimezone(JST)


def parse_pickup_datetime(local_datetime_str: str) -> datetime:
    from fastapi import HTTPException

    try:
        local_dt = datetime.fromisoformat(local_datetime_str)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid pickup datetime format.") from exc

    if local_dt.tzinfo is not None:
        return local_dt.astimezone(timezone.utc)

    return local_dt.replace(tzinfo=JST).astimezone(timezone.utc)


def next_pickup_default_jst(now: datetime) -> datetime:
    local_now = to_jst_datetime(now).replace(second=0, microsecond=0)
    minute = local_now.minute
    if minute not in (0, 30):
        if minute < 30:
            local_now = local_now.replace(minute=30)
        else:
            local_now = (local_now + timedelta(hours=1)).replace(minute=0)

    if local_now.hour < 9:
        return local_now.replace(hour=9, minute=0)
    if local_now.hour > 21 or (local_now.hour == 21 and local_now.minute > 0):
        next_day = local_now + timedelta(days=1)
        return next_day.replace(hour=9, minute=0)
    return local_now


def business_date_range_utc(business_date: str) -> tuple[datetime, datetime]:
    from fastapi import HTTPException

    try:
        start_jst = datetime.strptime(business_date, "%Y-%m-%d").replace(tzinfo=JST)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid business date.") from exc
    end_jst = start_jst + timedelta(days=1)
    return start_jst.astimezone(timezone.utc), end_jst.astimezone(timezone.utc)


def parse_business_date_value(value: str) -> date:
    from fastapi import HTTPException

    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid business date.") from exc


def date_to_ymd(value: date) -> str:
    return value.strftime("%Y-%m-%d")


def iter_business_dates(start_date: date, end_date: date) -> list[str]:
    if end_date < start_date:
        return []
    cursor = start_date
    values: list[str] = []
    while cursor <= end_date:
        values.append(date_to_ymd(cursor))
        cursor += timedelta(days=1)
    return values


def auto_pickup_note(created_at: datetime, expected_pickup_at: datetime) -> str:
    created_jst = to_jst_datetime(created_at)
    pickup_jst = to_jst_datetime(expected_pickup_at)
    if pickup_jst.date() <= created_jst.date():
        return ""
    return f"{pickup_jst.strftime('%m/%d')} 수령예정"
