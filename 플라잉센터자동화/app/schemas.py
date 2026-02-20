from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class PricePreviewResponse(BaseModel):
    set_qty: int
    price_per_day: int
    expected_storage_days: int
    discount_rate: float
    prepaid_amount: int


class OrderSummaryResponse(BaseModel):
    order_id: str
    created_at: datetime
    name: str
    phone: str
    companion_count: int
    suitcase_qty: int
    backpack_qty: int
    set_qty: int
    expected_pickup_at: datetime
    expected_storage_days: int
    price_per_day: int
    prepaid_amount: int
    payment_method: Optional[str]
    status: str
