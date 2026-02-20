from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Staff(Base):
    __tablename__ = "staff"

    staff_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    pin_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    orders: Mapped[list["Order"]] = relationship(back_populates="staff")


class Order(Base):
    __tablename__ = "orders"

    order_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str] = mapped_column(String(40), nullable=False)
    companion_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    suitcase_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    backpack_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    set_qty: Mapped[int] = mapped_column(Integer, nullable=False)

    expected_pickup_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    actual_pickup_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    expected_storage_days: Mapped[int] = mapped_column(Integer, nullable=False)
    actual_storage_days: Mapped[Optional[int]] = mapped_column(Integer)
    extra_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    price_per_day: Mapped[int] = mapped_column(Integer, nullable=False)
    discount_rate: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    prepaid_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    flying_pass_tier: Mapped[str] = mapped_column(String(20), default="NONE", nullable=False)
    flying_pass_discount_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    staff_prepaid_override_amount: Mapped[Optional[int]] = mapped_column(Integer)
    extra_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    final_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    payment_method: Mapped[Optional[str]] = mapped_column(String(40))

    status: Mapped[str] = mapped_column(String(30), default="PAYMENT_PENDING", nullable=False)
    tag_no: Mapped[Optional[str]] = mapped_column(String(40))
    note: Mapped[Optional[str]] = mapped_column(Text)

    id_image_url: Mapped[str] = mapped_column(Text, nullable=False)
    luggage_image_url: Mapped[str] = mapped_column(Text, nullable=False)

    consent_checked: Mapped[bool] = mapped_column(Boolean, nullable=False)
    manual_entry: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))

    staff: Mapped[Optional[Staff]] = relationship(back_populates="orders")
    audit_logs: Mapped[list["AuditLog"]] = relationship(back_populates="order")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    log_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.order_id"), nullable=False)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff.staff_id"), nullable=False)
    device_id: Mapped[str] = mapped_column(String(120), default="unknown", nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    order: Mapped[Order] = relationship(back_populates="audit_logs")


class DailyCounter(Base):
    __tablename__ = "daily_counters"

    business_date: Mapped[str] = mapped_column(String(8), primary_key=True)
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class DailyTagCounter(Base):
    __tablename__ = "daily_tag_counters"

    business_date: Mapped[str] = mapped_column(String(8), primary_key=True)
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class LostFoundEntry(Base):
    __tablename__ = "lost_found_entries"

    entry_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    found_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    item_name: Mapped[str] = mapped_column(String(160), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    found_location: Mapped[str] = mapped_column(String(160), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="STORED", nullable=False)
    claimed_by: Mapped[Optional[str]] = mapped_column(String(120))
    note: Mapped[Optional[str]] = mapped_column(Text)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class HandoverNote(Base):
    __tablename__ = "handover_notes"

    note_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(20), default="NOTICE", nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class HandoverRead(Base):
    __tablename__ = "handover_reads"

    read_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("handover_notes.note_id"), nullable=False)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff.staff_id"), nullable=False)
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class HandoverComment(Base):
    __tablename__ = "handover_comments"

    comment_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("handover_notes.note_id"), nullable=False)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff.staff_id"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class CashClosing(Base):
    __tablename__ = "cash_closings"

    closing_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    business_date: Mapped[str] = mapped_column(String(10), nullable=False)
    closing_type: Mapped[str] = mapped_column(String(30), default="FINAL_CLOSE", nullable=False)
    workflow_status: Mapped[str] = mapped_column(String(20), default="DRAFT", nullable=False)
    count_10000: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_5000: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_2000: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_1000: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_500: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_100: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_50: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_10: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_5: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    count_1: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    paypay_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    actual_qr_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    qr_difference_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    check_auto_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    expected_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    actual_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    difference_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    submitted_by_staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    verified_by_staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    check_cash_match: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    check_qr_match: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    check_pending_items: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    check_handover_note: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    owner_name: Mapped[Optional[str]] = mapped_column(String(80))
    note: Mapped[Optional[str]] = mapped_column(Text)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class CashClosingAudit(Base):
    __tablename__ = "cash_closing_audits"

    audit_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    closing_id: Mapped[int] = mapped_column(ForeignKey("cash_closings.closing_id"), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text)
    payload: Mapped[Optional[str]] = mapped_column(Text)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class RentalDailySales(Base):
    __tablename__ = "rental_daily_sales"
    __table_args__ = (UniqueConstraint("business_date", name="uq_rental_sales_business_date"),)

    rental_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    business_date: Mapped[str] = mapped_column(String(10), nullable=False)
    revenue_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    customer_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    note: Mapped[Optional[str]] = mapped_column(Text)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class AppSetting(Base):
    __tablename__ = "app_settings"

    setting_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    setting_key: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    setting_value: Mapped[str] = mapped_column(Text, nullable=False)
    staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class WorkSchedule(Base):
    __tablename__ = "work_schedules"

    schedule_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    work_date: Mapped[str] = mapped_column(String(10), nullable=False)
    staff_name: Mapped[str] = mapped_column(String(100), nullable=False)
    start_time: Mapped[str] = mapped_column(String(5), nullable=False)
    end_time: Mapped[str] = mapped_column(String(5), nullable=False)
    role: Mapped[Optional[str]] = mapped_column(String(80))
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by_staff_id: Mapped[Optional[int]] = mapped_column(ForeignKey("staff.staff_id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
