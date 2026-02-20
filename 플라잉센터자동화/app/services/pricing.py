from dataclasses import dataclass


SUITCASE_DAILY_RATE = 800
BACKPACK_DAILY_RATE = 500
SET_DAILY_RATE = 1200


@dataclass
class PricingResult:
    suitcase_qty: int
    backpack_qty: int
    set_qty: int
    price_per_day: int


def calculate_price_per_day(suitcase_qty: int, backpack_qty: int) -> PricingResult:
    if suitcase_qty < 0 or backpack_qty < 0:
        raise ValueError("Baggage quantities cannot be negative.")

    set_qty = min(suitcase_qty, backpack_qty)
    price_per_day = (
        set_qty * SET_DAILY_RATE
        + (suitcase_qty - set_qty) * SUITCASE_DAILY_RATE
        + (backpack_qty - set_qty) * BACKPACK_DAILY_RATE
    )

    return PricingResult(
        suitcase_qty=suitcase_qty,
        backpack_qty=backpack_qty,
        set_qty=set_qty,
        price_per_day=price_per_day,
    )


def discount_rate_for_days(storage_days: int) -> float:
    if storage_days >= 60:
        return 0.20
    if storage_days >= 30:
        return 0.15
    if storage_days >= 14:
        return 0.10
    if storage_days >= 7:
        return 0.05
    return 0.0


def calculate_prepaid_amount(price_per_day: int, expected_storage_days: int) -> tuple[float, int]:
    discount_rate = discount_rate_for_days(expected_storage_days)
    gross = price_per_day * expected_storage_days
    prepaid = int(round(gross * (1.0 - discount_rate)))
    return discount_rate, prepaid
