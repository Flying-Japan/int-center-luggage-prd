"""Sales analytics: order revenue summaries and period reporting."""
from __future__ import annotations

from fastapi import HTTPException

from app.supabase_client import SupabaseDB
from app.utils import (
    business_date_range_utc,
    date_to_ymd,
    iter_business_dates,
    parse_business_date_value,
    to_jst_datetime,
)


def summarize_order_sales_for_date(db: SupabaseDB, business_date: str) -> dict[str, int]:
    start_utc, end_utc = business_date_range_utc(business_date)
    orders = (
        db.query("orders")
        .filter(
            ("created_at", ">=", start_utc),
            ("created_at", "<", end_utc),
            ("status", "IN", ["PAID", "PICKED_UP"]),
        )
        .all()
    )

    cash_amount = 0
    qr_amount = 0
    for order in orders:
        amount = int(order.prepaid_amount or 0)
        if order.payment_method == "CASH":
            cash_amount += amount
        elif order.payment_method == "PAY_QR":
            qr_amount += amount

    return {
        "cash_amount": cash_amount,
        "qr_amount": qr_amount,
        "sales_total_amount": cash_amount + qr_amount,
    }


def summarize_order_pass_discount_for_date(db: SupabaseDB, business_date: str) -> int:
    start_utc, end_utc = business_date_range_utc(business_date)
    rows = (
        db.query("orders")
        .filter(
            ("created_at", ">=", start_utc),
            ("created_at", "<", end_utc),
            ("status", "IN", ["PAID", "PICKED_UP"]),
        )
        .all()
    )
    return sum(max(int(row.flying_pass_discount_amount or 0), 0) for row in rows)


def summarize_luggage_sales_for_period(
    db: SupabaseDB,
    start_date: str,
    end_date: str,
) -> dict[str, dict[str, int]]:
    start_date_value = parse_business_date_value(start_date)
    end_date_value = parse_business_date_value(end_date)
    if end_date_value < start_date_value:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")

    start_utc, _ = business_date_range_utc(start_date)
    _, end_exclusive_utc = business_date_range_utc(date_to_ymd(end_date_value))

    orders = (
        db.query("orders")
        .filter(
            ("created_at", ">=", start_utc),
            ("created_at", "<", end_exclusive_utc),
            ("status", "IN", ["PAID", "PICKED_UP"]),
        )
        .all()
    )

    by_date: dict[str, dict[str, int]] = {}
    for order in orders:
        business_date = to_jst_datetime(order.created_at).strftime("%Y-%m-%d")
        entry = by_date.setdefault(
            business_date,
            {
                "luggage_revenue": 0,
                "luggage_customers": 0,
                "luggage_cash": 0,
                "luggage_qr": 0,
                "luggage_orders": 0,
            },
        )
        amount = max(int(order.prepaid_amount or 0), 0)
        customer_count = max(int(order.companion_count or 1), 1)

        entry["luggage_revenue"] += amount
        entry["luggage_customers"] += customer_count
        entry["luggage_orders"] += 1
        if order.payment_method == "CASH":
            entry["luggage_cash"] += amount
        elif order.payment_method == "PAY_QR":
            entry["luggage_qr"] += amount

    return by_date


def build_sales_analytics(
    db: SupabaseDB,
    start_date: str,
    end_date: str,
) -> dict[str, object]:
    start_date_value = parse_business_date_value(start_date)
    end_date_value = parse_business_date_value(end_date)
    if end_date_value < start_date_value:
        raise HTTPException(status_code=400, detail="End date must be on or after start date.")

    business_dates = iter_business_dates(start_date_value, end_date_value)
    luggage_by_date = summarize_luggage_sales_for_period(db, start_date, end_date)

    rental_rows = (
        db.query("rental_daily_sales")
        .filter(
            ("business_date", ">=", start_date),
            ("business_date", "<=", end_date),
        )
        .all()
    )
    rental_by_date: dict[str, dict[str, int]] = {}
    for row in rental_rows:
        entry = rental_by_date.setdefault(
            row.business_date,
            {
                "rental_revenue": 0,
                "rental_customers": 0,
            },
        )
        entry["rental_revenue"] += max(int(row.revenue_amount or 0), 0)
        entry["rental_customers"] += max(int(row.customer_count or 0), 0)

    daily_rows: list[dict[str, object]] = []
    totals = {
        "luggage_revenue": 0,
        "rental_revenue": 0,
        "combined_revenue": 0,
        "luggage_customers": 0,
        "rental_customers": 0,
        "luggage_cash": 0,
        "luggage_qr": 0,
        "luggage_orders": 0,
    }
    monthly_map: dict[str, dict[str, int]] = {}

    for business_date in business_dates:
        luggage = luggage_by_date.get(
            business_date,
            {
                "luggage_revenue": 0,
                "luggage_customers": 0,
                "luggage_cash": 0,
                "luggage_qr": 0,
                "luggage_orders": 0,
            },
        )
        rental = rental_by_date.get(
            business_date,
            {
                "rental_revenue": 0,
                "rental_customers": 0,
            },
        )

        combined_revenue = luggage["luggage_revenue"] + rental["rental_revenue"]
        daily_rows.append(
            {
                "business_date": business_date,
                "luggage_revenue": luggage["luggage_revenue"],
                "rental_revenue": rental["rental_revenue"],
                "combined_revenue": combined_revenue,
                "luggage_customers": luggage["luggage_customers"],
                "rental_customers": rental["rental_customers"],
                "luggage_cash": luggage["luggage_cash"],
                "luggage_qr": luggage["luggage_qr"],
                "luggage_orders": luggage["luggage_orders"],
            }
        )

        totals["luggage_revenue"] += luggage["luggage_revenue"]
        totals["rental_revenue"] += rental["rental_revenue"]
        totals["combined_revenue"] += combined_revenue
        totals["luggage_customers"] += luggage["luggage_customers"]
        totals["rental_customers"] += rental["rental_customers"]
        totals["luggage_cash"] += luggage["luggage_cash"]
        totals["luggage_qr"] += luggage["luggage_qr"]
        totals["luggage_orders"] += luggage["luggage_orders"]

        month_key = business_date[:7]
        month_entry = monthly_map.setdefault(
            month_key,
            {
                "luggage_revenue": 0,
                "rental_revenue": 0,
                "combined_revenue": 0,
                "luggage_customers": 0,
                "rental_customers": 0,
            },
        )
        month_entry["luggage_revenue"] += luggage["luggage_revenue"]
        month_entry["rental_revenue"] += rental["rental_revenue"]
        month_entry["combined_revenue"] += combined_revenue
        month_entry["luggage_customers"] += luggage["luggage_customers"]
        month_entry["rental_customers"] += rental["rental_customers"]

    monthly_rows = [
        {
            "month": month,
            "luggage_revenue": values["luggage_revenue"],
            "rental_revenue": values["rental_revenue"],
            "combined_revenue": values["combined_revenue"],
            "luggage_customers": values["luggage_customers"],
            "rental_customers": values["rental_customers"],
        }
        for month, values in sorted(monthly_map.items())
    ]

    day_count = len(business_dates)
    avg_daily_revenue = round(totals["combined_revenue"] / day_count) if day_count else 0
    avg_luggage_order_revenue = (
        round(totals["luggage_revenue"] / totals["luggage_orders"]) if totals["luggage_orders"] else 0
    )

    chart = {
        "daily_labels": [row["business_date"] for row in daily_rows],
        "daily_luggage": [row["luggage_revenue"] for row in daily_rows],
        "daily_rental": [row["rental_revenue"] for row in daily_rows],
        "daily_combined": [row["combined_revenue"] for row in daily_rows],
        "monthly_labels": [row["month"] for row in monthly_rows],
        "monthly_luggage": [row["luggage_revenue"] for row in monthly_rows],
        "monthly_rental": [row["rental_revenue"] for row in monthly_rows],
        "monthly_combined": [row["combined_revenue"] for row in monthly_rows],
    }

    return {
        "daily_rows": daily_rows,
        "monthly_rows": monthly_rows,
        "totals": totals,
        "chart": chart,
        "avg_daily_revenue": avg_daily_revenue,
        "avg_luggage_order_revenue": avg_luggage_order_revenue,
        "range_days": day_count,
    }
