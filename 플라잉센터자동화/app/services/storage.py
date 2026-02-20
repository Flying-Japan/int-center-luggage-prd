from datetime import datetime, time, timezone

from app.config import BUSINESS_CLOSE_HOUR, BUSINESS_OPEN_HOUR, JST


def to_jst(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(JST)


def validate_pickup_time_window(pickup_at: datetime) -> None:
    local_dt = to_jst(pickup_at)
    open_time = time(BUSINESS_OPEN_HOUR, 0)
    close_time = time(BUSINESS_CLOSE_HOUR, 0)
    if not (open_time <= local_dt.time() <= close_time):
        raise ValueError("Pickup time must be within business hours 09:00-21:00 JST.")


def calculate_storage_days(created_at: datetime, pickup_at: datetime) -> int:
    created_local = to_jst(created_at)
    pickup_local = to_jst(pickup_at)
    if pickup_local < created_local:
        raise ValueError("Pickup time cannot be before the order creation time.")
    days = (pickup_local.date() - created_local.date()).days + 1
    return max(days, 1)
