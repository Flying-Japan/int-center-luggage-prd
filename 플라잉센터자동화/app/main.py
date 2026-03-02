import base64
import hashlib
import io
import logging
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import supabase

import qrcode
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from app.auth import get_current_staff
from app.config import (
    JST,
    MAX_BAG_QTY,
    MAX_COMPANION_COUNT,
    SECRET_KEY,
    SESSION_HTTPS_ONLY,
    SESSION_MAX_AGE,
    SESSION_SAME_SITE,
    APP_BASE_URL,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
)
from app.display import (
    cash_closing_status_pill_class,
    display_cash_closing_audit_action,
    display_cash_closing_status,
    display_cash_closing_type,
    display_flying_pass_tier,
    display_lost_found_status,
    display_note_category,
    display_payment_method,
)
from app.r2 import r2_upload, r2_download
from app.supabase_client import SupabaseDB
from app.database import get_db
from app.i18n import get_translations
from app.schemas import OrderSummaryResponse, PricePreviewResponse
from app.services.cash_closing import (
    CASH_CLOSING_STATUSES,
    CASH_CLOSING_TYPES,
    COIN_BILL_DENOMS,
    build_cash_closing_fields,
    create_cash_closing_audit,
    ensure_unique_cash_closing_type,
    parse_cash_closing_type,
    parse_denomination_counts,
)
from app.services.completion_messages import (
    SUCCESS_PRIMARY_MESSAGE_KEYS,
    SUCCESS_SECONDARY_MESSAGE_KEYS,
    build_completion_messages_from_ko,
    load_completion_messages,
)
from app.services.flying_pass import (
    build_flying_pass_tiers_json,
    flying_pass_discount_amount,
    normalize_flying_pass_tier,
    recalculate_order_prepaid,
)
from app.services.order_number import build_order_id, build_tag_no
from app.services.settings import get_app_setting, upsert_app_setting
from app.services.pricing import calculate_prepaid_amount, calculate_price_per_day
from app.services.retention import run_retention_cleanup
from app.services.sales import (
    build_sales_analytics,
    summarize_order_pass_discount_for_date,
    summarize_order_sales_for_date,
)
from app.services.storage import calculate_storage_days, validate_pickup_time_window
from app.utils import (
    auto_pickup_note,
    business_date_range_utc,
    date_to_ymd,
    format_yen,
    next_pickup_default_jst,
    parse_pickup_datetime,
    to_jst_datetime,
    utc_now,
)


app = FastAPI(title="Flying Japan Luggage Storage MVP")
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    https_only=SESSION_HTTPS_ONLY,
    same_site=SESSION_SAME_SITE,
    max_age=SESSION_MAX_AGE,
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
templates.env.filters["yen"] = format_yen

import traceback as _tb

@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, _tb.format_exc())
    return JSONResponse(status_code=500, content={"detail": str(exc), "type": type(exc).__name__})


DISCOUNT_TABLE = [
    {"days": "1~6", "rate": "0%"},
    {"days": "7~13", "rate": "5%"},
    {"days": "14~29", "rate": "10%"},
    {"days": "30~59", "rate": "15%"},
    {"days": "60+", "rate": "20%"},
]

CUSTOMER_PAYMENT_METHODS = {"PAY_QR", "CASH"}
STAFF_PAYMENT_METHODS = {"PAY_QR", "CASH"}
STAFF_STATUS_FILTERS = ("PAYMENT_PENDING", "PAID", "PICKED_UP")
OAUTH_ERROR_MESSAGES = {
    "oauth_failed": "Google 로그인에 실패했습니다.",
    "state_missing": "인증 세션이 만료되었습니다. 다시 시도해 주세요.",
    "exchange_failed": "Google 인증을 처리할 수 없습니다.",
    "no_user": "사용자 정보를 가져올 수 없습니다.",
    "access_denied": "접근 권한이 없습니다.",
}
LOST_FOUND_STATUSES = ("STORED", "RETURNED", "DISPOSED")
NOTE_CATEGORIES = ("NOTICE", "HANDOVER")
def validate_bag_quantities(suitcase_qty: int, backpack_qty: int) -> None:
    if suitcase_qty < 0 or backpack_qty < 0:
        raise HTTPException(status_code=400, detail="Bag quantities cannot be negative.")
    if suitcase_qty > MAX_BAG_QTY or backpack_qty > MAX_BAG_QTY:
        raise HTTPException(status_code=400, detail=f"Max quantity per type is {MAX_BAG_QTY}.")
    if suitcase_qty == 0 and backpack_qty == 0:
        raise HTTPException(status_code=400, detail="At least one bag is required.")
RECENT_PICKED_UP_DAYS = 2
STAFF_BASE_MENU_ITEMS = (
    ("dashboard", "접수", "/staff/dashboard"),
    ("lost_found", "분실물", "/staff/lost-found"),
    ("handover", "안내/인계", "/staff/handover"),
    ("cash_closing", "시제정산", "/staff/cash-closing"),
    ("schedule", "근무표", "/staff/schedule"),
)
ADMIN_MENU_ITEMS = (
    ("admin_sales", "매출", "/staff/admin/sales"),
    ("completion_message", "완료문구", "/staff/admin/completion-message"),
    ("staff_accounts", "계정관리", "/staff/admin/staff-accounts"),
)
SCHEDULE_GOOGLE_EMBED_URL_KEY = "schedule_google_embed_url"
SCHEDULE_FEATURE_ENABLED_KEY = "schedule_feature_enabled"


def save_image_file(upload: UploadFile, folder: str, order_id: str, label: str) -> str:
    if not upload.content_type or not upload.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"{label} must be an image file.")

    extension = Path(upload.filename or "").suffix.lower()
    if extension not in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
        extension = ".jpg"

    filename = f"{order_id}-{uuid.uuid4().hex}{extension}"
    storage_path = f"{folder}/{filename}"
    file_bytes = upload.file.read()

    r2_upload(storage_path, file_bytes, upload.content_type)

    return storage_path


def order_to_response(order) -> OrderSummaryResponse:
    return OrderSummaryResponse(
        order_id=order.order_id,
        created_at=order.created_at,
        name=order.name,
        phone=order.phone,
        companion_count=order.companion_count,
        suitcase_qty=order.suitcase_qty,
        backpack_qty=order.backpack_qty,
        set_qty=order.set_qty,
        expected_pickup_at=order.expected_pickup_at,
        expected_storage_days=order.expected_storage_days,
        price_per_day=order.price_per_day,
        prepaid_amount=order.prepaid_amount,
        payment_method=order.payment_method,
        status=order.status,
    )


def generate_qr_base64(data: str) -> str:
    image = qrcode.make(data)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def ensure_staff(request: Request, db: SupabaseDB):
    return get_current_staff(request, db)


def build_staff_menu(db: SupabaseDB, active_key: str, is_admin: bool = False) -> list[dict[str, object]]:
    items = list(STAFF_BASE_MENU_ITEMS)
    if not is_schedule_feature_enabled(db) and not is_admin:
        items = [item for item in items if item[0] != "schedule"]
    if is_admin:
        items.extend(ADMIN_MENU_ITEMS)
    return [
        {"key": key, "label": label, "href": href, "active": key == active_key}
        for key, label, href in items
    ]


def resolved_note(order) -> str:
    manual_note = (order.note or "").strip()
    if manual_note:
        return manual_note
    return auto_pickup_note(order.created_at, order.expected_pickup_at)


def payment_status_of(order) -> str:
    return "PAYMENT_PENDING" if order.status == "PAYMENT_PENDING" else "PAID"


def normalize_status_filters(raw_filters: list[str]) -> list[str]:
    normalized: list[str] = []
    for raw_value in raw_filters:
        for token in str(raw_value or "").split(","):
            value = token.strip().upper()
            if value in STAFF_STATUS_FILTERS and value not in normalized:
                normalized.append(value)
    if not normalized:
        return list(STAFF_STATUS_FILTERS)
    return normalized


def build_new_order_record(
    *,
    order_id: str,
    now: datetime,
    name: str,
    phone: str,
    companion_count: int,
    suitcase_qty: int,
    backpack_qty: int,
    set_qty: int,
    pickup_at: datetime,
    expected_storage_days: int,
    price_per_day: int,
    discount_rate: float,
    prepaid_amount: int,
    payment_method: Optional[str],
    tag_no: str,
    id_image_url: str = "",
    luggage_image_url: str = "",
    manual_entry: bool = False,
    staff_id: Optional[str] = None,
) -> dict:
    return {
        "order_id": order_id,
        "created_at": now,
        "name": name.strip(),
        "phone": phone.strip(),
        "companion_count": companion_count,
        "suitcase_qty": suitcase_qty,
        "backpack_qty": backpack_qty,
        "set_qty": set_qty,
        "expected_pickup_at": pickup_at,
        "expected_storage_days": expected_storage_days,
        "actual_storage_days": None,
        "extra_days": 0,
        "price_per_day": price_per_day,
        "discount_rate": discount_rate,
        "prepaid_amount": prepaid_amount,
        "flying_pass_tier": "NONE",
        "flying_pass_discount_amount": 0,
        "staff_prepaid_override_amount": None,
        "extra_amount": 0,
        "final_amount": prepaid_amount,
        "payment_method": payment_method,
        "status": "PAYMENT_PENDING",
        "tag_no": tag_no,
        "note": auto_pickup_note(now, pickup_at) or None,
        "id_image_url": id_image_url,
        "luggage_image_url": luggage_image_url,
        "consent_checked": True,
        "manual_entry": manual_entry,
        "staff_id": staff_id,
    }


def resolve_staff_names(db: SupabaseDB, staff_ids: set) -> dict[int, str]:
    if not staff_ids:
        return {}
    staff_rows = db.query("user_profiles").filter(("id", "IN", list(staff_ids))).all()
    return {row.id: row.username for row in staff_rows}


def build_admin_sales_redirect(
    start_date: str,
    end_date: str,
    edit_rental_id: Optional[int] = None,
) -> str:
    query = {
        "start_date": start_date,
        "end_date": end_date,
    }
    if edit_rental_id:
        query["edit_rental_id"] = str(edit_rental_id)
    return f"/staff/admin/sales?{urlencode(query)}"


def build_staff_accounts_redirect(
    *,
    msg: str = "",
    err: str = "",
    focus_staff_id: Optional[str] = None,
) -> str:
    query: dict[str, str] = {}
    if msg.strip():
        query["msg"] = msg.strip()
    if err.strip():
        query["err"] = err.strip()
    if focus_staff_id is not None:
        query["focus_staff_id"] = str(int(focus_staff_id))
    if query:
        return f"/staff/admin/staff-accounts?{urlencode(query)}"
    return "/staff/admin/staff-accounts"


def is_schedule_feature_enabled(db: SupabaseDB) -> bool:
    value = get_app_setting(db, SCHEDULE_FEATURE_ENABLED_KEY, "1")
    return value.lower() not in {"0", "false", "off", "no"}


def normalize_schedule_embed_url(raw_value: str) -> str:
    value = (raw_value or "").strip()
    if not value:
        return ""

    iframe_match = re.search(r'src=["\']([^"\']+)["\']', value, flags=re.IGNORECASE)
    if iframe_match:
        value = iframe_match.group(1).strip()

    parsed = urlparse(value)
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if parsed.scheme != "https" or host != "calendar.google.com":
        raise HTTPException(
            status_code=400,
            detail="Google Calendar 임베드 주소(https://calendar.google.com/...)만 입력할 수 있습니다.",
        )

    query = parse_qs(parsed.query, keep_blank_values=True)
    if "/calendar/embed" in (parsed.path or ""):
        if "ctz" not in query:
            query["ctz"] = ["Asia/Tokyo"]
        params: list[tuple[str, str]] = []
        for key, values in query.items():
            for item in values:
                params.append((key, item))
        return f"https://calendar.google.com{parsed.path}?{urlencode(params)}"

    source_id = (query.get("src") or query.get("cid") or [""])[-1].strip()
    if source_id:
        return (
            "https://calendar.google.com/calendar/embed?"
            + urlencode(
                {
                    "src": source_id,
                    "ctz": "Asia/Tokyo",
                }
            )
        )

    raise HTTPException(
        status_code=400,
        detail="캘린더 통합의 임베드 링크 또는 공개 캘린더 링크를 입력해주세요.",
    )



def serialize_staff_order(order) -> dict[str, object]:
    expected_jst = to_jst_datetime(order.expected_pickup_at)
    resolved_tier = normalize_flying_pass_tier(order.flying_pass_tier)
    _discount_rate, base_prepaid_amount = calculate_prepaid_amount(order.price_per_day, order.expected_storage_days)
    member_discount_amount = flying_pass_discount_amount(base_prepaid_amount, resolved_tier)
    auto_prepaid_amount = max(int(base_prepaid_amount) - member_discount_amount, 0)
    return {
        "order_id": order.order_id,
        "name": order.name,
        "tag_no": order.tag_no or "",
        "created_time": to_jst_datetime(order.created_at).strftime("%m/%d %H:%M"),
        "suitcase_qty": order.suitcase_qty,
        "backpack_qty": order.backpack_qty,
        "set_qty": order.set_qty,
        "price_per_day": int(order.price_per_day or 0),
        "expected_storage_days": int(order.expected_storage_days or 1),
        "prepaid_amount": order.prepaid_amount,
        "base_prepaid_amount": int(base_prepaid_amount),
        "auto_prepaid_amount": int(auto_prepaid_amount),
        "flying_pass_tier": resolved_tier,
        "flying_pass_tier_label": display_flying_pass_tier(resolved_tier),
        "flying_pass_discount_amount": int(member_discount_amount),
        "is_price_overridden": order.staff_prepaid_override_amount is not None,
        "payment_method_code": order.payment_method or "PAY_QR",
        "payment_method_label": display_payment_method(order.payment_method),
        "payment_status": payment_status_of(order),
        "is_picked_up": order.status == "PICKED_UP",
        "expected_pickup_time": expected_jst.strftime("%H:%M"),
        "expected_pickup_date": expected_jst.strftime("%Y-%m-%d"),
        "luggage_image_url": f"/staff/orders/{order.order_id}/luggage-image" if order.luggage_image_url else "",
        "note": resolved_note(order),
        "detail_url": f"/staff/orders/{order.order_id}",
    }


def apply_pickup_completion(order, staff_id: str) -> None:
    now = utc_now()
    actual_days = calculate_storage_days(order.created_at, now)
    extra_days = max(actual_days - order.expected_storage_days, 0)
    extra_amount = extra_days * order.price_per_day

    order.actual_pickup_at = now
    order.actual_storage_days = actual_days
    order.extra_days = extra_days
    order.extra_amount = extra_amount
    order.final_amount = order.prepaid_amount + extra_amount
    order.status = "PICKED_UP"
    order.staff_id = staff_id


def undo_pickup_completion(order, staff_id: str) -> None:
    order.actual_pickup_at = None
    order.actual_storage_days = None
    order.extra_days = 0
    order.extra_amount = 0
    order.final_amount = order.prepaid_amount
    order.status = "PAID" if order.payment_method in STAFF_PAYMENT_METHODS else "PAYMENT_PENDING"
    order.staff_id = staff_id


def query_staff_orders(
    db: SupabaseDB,
    status_filters: list[str],
    q: str,
    limit: int = 300,
    show_all_picked_up: bool = False,
) -> list:
    query = db.query("orders")
    if status_filters:
        query = query.filter(("status", "IN", status_filters))
    if not show_all_picked_up:
        cutoff_jst = (
            utc_now().astimezone(JST).replace(hour=0, minute=0, second=0, microsecond=0)
            - timedelta(days=RECENT_PICKED_UP_DAYS - 1)
        )
        cutoff_utc = cutoff_jst.astimezone(timezone.utc)
        query = query.filter_or([
            ("status", "!=", "PICKED_UP"),
            ("actual_pickup_at", "IS NULL", None),
            ("actual_pickup_at", ">=", cutoff_utc),
        ])
    if q.strip():
        keyword = f"%{q.strip()}%"
        query = query.filter_or([
            ("order_id", "LIKE", keyword),
            ("name", "LIKE", keyword),
            ("phone", "LIKE", keyword),
            ("tag_no", "LIKE", keyword),
        ])
    return query.order_by("created_at ASC", "order_id ASC").limit(limit).all()


def backfill_missing_tag_numbers(db: SupabaseDB) -> None:
    orders = db.query("orders").order_by("created_at ASC", "order_id ASC").all()
    last_by_day: dict[str, int] = {}

    for order in orders:
        business_date = to_jst_datetime(order.created_at).strftime("%Y%m%d")
        current_last = last_by_day.get(business_date, 0)
        existing_tag = (order.tag_no or "").strip()

        if existing_tag.isdigit():
            tag_seq = int(existing_tag)
            if tag_seq > current_last:
                last_by_day[business_date] = tag_seq
            continue

        next_seq = current_last + 1
        order.tag_no = str(next_seq)
        last_by_day[business_date] = next_seq
        db.update(order)

    for business_date, last_seq in last_by_day.items():
        counter = db.get("daily_tag_counters", "business_date", business_date)
        if counter is None:
            db.insert("daily_tag_counters", {"business_date": business_date, "last_seq": last_seq})
            continue
        if counter.last_seq < last_seq:
            counter.last_seq = last_seq
            db.update(counter)




def build_handover_context(
    db: SupabaseDB,
    staff,
    *,
    edit_id: Optional[int] = None,
    search_query: str = "",
    unread_only: bool = False,
) -> dict:
    note_query = db.query("handover_notes")
    if search_query:
        search_like = f"%{search_query}%"
        matched_staff_ids = [
            row.id for row in db.query("user_profiles").filter(("username", "LIKE", search_like)).all()
        ]
        matched_note_ids_from_comments = list({
            row.note_id
            for row in db.query("handover_comments").filter(("content", "LIKE", search_like)).all()
        })
        filters: list[tuple] = [
            ("title", "LIKE", search_like),
            ("content", "LIKE", search_like),
        ]
        if matched_staff_ids:
            filters.append(("staff_id", "IN", matched_staff_ids))
        if matched_note_ids_from_comments:
            filters.append(("note_id", "IN", matched_note_ids_from_comments))
        note_query = note_query.filter_or(filters)

    notes = (
        note_query.order_by("is_pinned DESC", "created_at DESC", "note_id DESC")
        .limit(500)
        .all()
    )
    editing_note = db.get("handover_notes", "note_id", edit_id) if edit_id else None

    note_ids = [note.note_id for note in notes]
    reads: list = []
    current_staff_read_note_ids: set[int] = set()
    if note_ids:
        reads = (
            db.query("handover_reads")
            .filter(("note_id", "IN", note_ids))
            .order_by("note_id ASC", "read_at ASC", "read_id ASC")
            .all()
        )
    current_staff_read_note_ids = {read.note_id for read in reads if read.staff_id == staff.staff_id}

    unread_notes = [note for note in notes if note.note_id not in current_staff_read_note_ids]
    read_notes = [note for note in notes if note.note_id in current_staff_read_note_ids]
    notes = unread_notes + read_notes
    if unread_only:
        notes = unread_notes
    notes = notes[:300]
    note_ids = [note.note_id for note in notes]

    comments: list = []
    if note_ids:
        comments = (
            db.query("handover_comments")
            .filter(("note_id", "IN", note_ids))
            .order_by("note_id ASC", "created_at ASC", "comment_id ASC")
            .all()
        )

    staff_ids = {note.staff_id for note in notes if note.staff_id}
    staff_ids.update(read.staff_id for read in reads)
    staff_ids.update(comment.staff_id for comment in comments if comment.staff_id)
    staff_name_by_id = resolve_staff_names(db, staff_ids)

    author_name_by_note = {
        note.note_id: staff_name_by_id.get(note.staff_id or -1, "알 수 없음")
        for note in notes
    }

    reader_names_by_note: dict[int, list[str]] = {note.note_id: [] for note in notes}
    for read in reads:
        names = reader_names_by_note.setdefault(read.note_id, [])
        name = staff_name_by_id.get(read.staff_id, f"ID {read.staff_id}")
        if name not in names:
            names.append(name)

    comments_by_note: dict[int, list] = {note.note_id: [] for note in notes}
    comment_author_name_by_id: dict[int, str] = {}
    note_search_text_by_note: dict[int, str] = {}
    for comment in comments:
        comments_by_note.setdefault(comment.note_id, []).append(comment)
        comment_author_name_by_id[comment.comment_id] = staff_name_by_id.get(comment.staff_id, f"ID {comment.staff_id}")

    for note in notes:
        author_name = author_name_by_note.get(note.note_id, "")
        comment_text = " ".join(comment.content for comment in comments_by_note.get(note.note_id, []))
        search_blob = " ".join(
            [
                note.title or "",
                note.content or "",
                author_name or "",
                comment_text or "",
            ]
        ).strip()
        note_search_text_by_note[note.note_id] = search_blob.lower()

    return {
        "staff": staff,
        "staff_menu_items": build_staff_menu(db, "handover", staff.is_admin),
        "notes": notes,
        "editing_note": editing_note,
        "author_name_by_note": author_name_by_note,
        "reader_names_by_note": reader_names_by_note,
        "current_staff_read_note_ids": current_staff_read_note_ids,
        "comments_by_note": comments_by_note,
        "comment_author_name_by_id": comment_author_name_by_id,
        "note_search_text_by_note": note_search_text_by_note,
        "NOTE_CATEGORIES": NOTE_CATEGORIES,
        "display_note_category": display_note_category,
        "to_jst_datetime": to_jst_datetime,
        "q": search_query,
        "unread_only": unread_only,
    }


def build_cash_closing_context(
    db: SupabaseDB,
    staff,
    *,
    edit_id: Optional[int] = None,
) -> dict:
    closings = (
        db.query("cash_closings")
        .order_by("business_date DESC", "created_at DESC", "closing_id DESC")
        .limit(300)
        .all()
    )
    editing_closing = db.get("cash_closings", "closing_id", edit_id) if edit_id else None
    if edit_id and editing_closing is None:
        raise HTTPException(status_code=404, detail="Cash closing not found.")

    closing_ids = [row.closing_id for row in closings]
    create_audits: list = []
    if closing_ids:
        create_audits = (
            db.query("cash_closing_audits")
            .filter(
                ("closing_id", "IN", closing_ids),
                ("action", "=", "CREATE"),
            )
            .order_by("closing_id ASC", "created_at ASC", "audit_id ASC")
            .all()
        )

    staff_ids = {row.staff_id for row in closings if row.staff_id}
    staff_ids.update(row.submitted_by_staff_id for row in closings if row.submitted_by_staff_id)
    staff_ids.update(row.verified_by_staff_id for row in closings if row.verified_by_staff_id)
    staff_ids.update(audit.staff_id for audit in create_audits if audit.staff_id)
    if editing_closing:
        if editing_closing.staff_id:
            staff_ids.add(editing_closing.staff_id)
        if editing_closing.submitted_by_staff_id:
            staff_ids.add(editing_closing.submitted_by_staff_id)
        if editing_closing.verified_by_staff_id:
            staff_ids.add(editing_closing.verified_by_staff_id)
    staff_name_by_id = resolve_staff_names(db, staff_ids)
    creator_name_by_closing: dict[int, str] = {}
    for audit in create_audits:
        if audit.closing_id in creator_name_by_closing:
            continue
        if not audit.staff_id:
            continue
        creator_name_by_closing[audit.closing_id] = staff_name_by_id.get(audit.staff_id, f"ID {audit.staff_id}")

    today = utc_now().astimezone(JST).strftime("%Y-%m-%d")
    today_rows = [row for row in closings if row.business_date == today]
    today_types = {row.closing_type for row in today_rows}
    if "MORNING_HANDOVER" not in today_types:
        default_closing_type = "MORNING_HANDOVER"
    elif "FINAL_CLOSE" not in today_types:
        default_closing_type = "FINAL_CLOSE"
    else:
        default_closing_type = "FINAL_CLOSE"
    today_sales = summarize_order_sales_for_date(db, today)
    closing_dates = {row.business_date for row in closings}
    pass_discount_by_date = {
        business_date: summarize_order_pass_discount_for_date(db, business_date)
        for business_date in closing_dates
    }

    return {
        "staff": staff,
        "staff_menu_items": build_staff_menu(db, "cash_closing", staff.is_admin),
        "closings": closings,
        "editing_closing": editing_closing,
        "staff_name_by_id": staff_name_by_id,
        "creator_name_by_closing": creator_name_by_closing,
        "today": today,
        "today_cash_count_sum": sum(row.total_amount for row in today_rows),
        "today_total_sum": sum(row.total_amount for row in today_rows),
        "today_check_sum": sum(row.check_auto_amount for row in today_rows),
        "today_diff_sum": sum(row.difference_amount for row in today_rows),
        "today_qr_diff_sum": sum(row.qr_difference_amount for row in today_rows),
        "today_total_diff_sum": sum((row.difference_amount + row.qr_difference_amount) for row in today_rows),
        "today_paypay_sum": sum(row.paypay_amount for row in today_rows),
        "today_auto_cash_sales": today_sales["cash_amount"],
        "today_auto_qr_sales": today_sales["qr_amount"],
        "today_auto_total_sales": today_sales["sales_total_amount"],
        "pass_discount_by_date": pass_discount_by_date,
        "default_closing_type": default_closing_type,
        "editing_is_locked": bool(editing_closing and editing_closing.workflow_status == "LOCKED"),
        "COIN_BILL_DENOMS": COIN_BILL_DENOMS,
        "to_jst_datetime": to_jst_datetime,
        "CASH_CLOSING_TYPES": CASH_CLOSING_TYPES,
        "CASH_CLOSING_STATUSES": CASH_CLOSING_STATUSES,
        "display_cash_closing_type": display_cash_closing_type,
        "display_cash_closing_status": display_cash_closing_status,
        "cash_closing_status_pill_class": cash_closing_status_pill_class,
    }


logger = logging.getLogger("flying-center")


def _retention_scheduler() -> None:
    """Background thread: run retention cleanup daily at 03:00 JST."""
    while True:
        now = datetime.now(JST)
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        time.sleep((next_run - now).total_seconds())
        try:
            db = SupabaseDB(url=SUPABASE_URL, service_role_key=SUPABASE_SERVICE_ROLE_KEY)
            try:
                result = run_retention_cleanup(db)
                logger.info("Retention cleanup: %s", result)
            finally:
                db.close()
        except Exception:
            logger.exception("Retention cleanup failed")


@app.on_event("startup")
def on_startup() -> None:
    db = SupabaseDB(url=SUPABASE_URL, service_role_key=SUPABASE_SERVICE_ROLE_KEY)
    try:
        backfill_missing_tag_numbers(db)
    finally:
        db.close()

    t = threading.Thread(target=_retention_scheduler, daemon=True)
    t.start()
    logger.info("Retention scheduler started (daily 03:00 JST)")


@app.get("/", response_class=HTMLResponse)
def root() -> RedirectResponse:
    return RedirectResponse(url="/customer")


@app.get("/admin")
def admin_landing() -> RedirectResponse:
    return RedirectResponse(url="/staff/login")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/customer", response_class=HTMLResponse)
def customer_form(request: Request, lang: str = "ko") -> HTMLResponse:
    normalized_lang, t = get_translations(lang)
    return templates.TemplateResponse(
        "customer_form.html",
        {
            "request": request,
            "lang": normalized_lang,
            "t": t,
            "discount_table": DISCOUNT_TABLE,
            "max_bag_qty": MAX_BAG_QTY,
            "max_companion_count": MAX_COMPANION_COUNT,
        },
    )


@app.get("/api/price-preview", response_model=PricePreviewResponse)
def price_preview(
    suitcase_qty: int,
    backpack_qty: int,
    expected_pickup_at: str,
) -> PricePreviewResponse:
    validate_bag_quantities(suitcase_qty, backpack_qty)

    pickup_at = parse_pickup_datetime(expected_pickup_at)
    now = utc_now()
    try:
        validate_pickup_time_window(pickup_at)
        expected_storage_days = calculate_storage_days(now, pickup_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    pricing = calculate_price_per_day(suitcase_qty, backpack_qty)
    discount_rate, prepaid_amount = calculate_prepaid_amount(pricing.price_per_day, expected_storage_days)

    return PricePreviewResponse(
        set_qty=pricing.set_qty,
        price_per_day=pricing.price_per_day,
        expected_storage_days=expected_storage_days,
        discount_rate=discount_rate,
        prepaid_amount=prepaid_amount,
    )


@app.post("/customer/submit")
def customer_submit(
    request: Request,
    name: str = Form(...),
    phone: str = Form(...),
    companion_count: int = Form(...),
    payment_method: str = Form(...),
    suitcase_qty: int = Form(...),
    backpack_qty: int = Form(...),
    expected_pickup_at: str = Form(...),
    consent_checked: str = Form(""),
    lang: str = Form("ko"),
    id_image: UploadFile = File(...),
    luggage_image: UploadFile = File(...),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    if not name.strip() or not phone.strip():
        raise HTTPException(status_code=400, detail="Name and phone are required.")
    if companion_count < 1 or companion_count > MAX_COMPANION_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Companion count must be 1~{MAX_COMPANION_COUNT}.",
        )
    if payment_method not in CUSTOMER_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method.")

    validate_bag_quantities(suitcase_qty, backpack_qty)

    if consent_checked != "on":
        raise HTTPException(status_code=400, detail="Consent is required.")

    now = utc_now()
    pickup_at = parse_pickup_datetime(expected_pickup_at)
    try:
        validate_pickup_time_window(pickup_at)
        expected_storage_days = calculate_storage_days(now, pickup_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if pickup_at < now:
        raise HTTPException(status_code=400, detail="Expected pickup time must be in the future.")

    pricing = calculate_price_per_day(suitcase_qty, backpack_qty)
    discount_rate, prepaid_amount = calculate_prepaid_amount(pricing.price_per_day, expected_storage_days)

    order_id = build_order_id(db, now)
    id_image_path = save_image_file(id_image, "id", order_id, "ID image")
    luggage_image_path = save_image_file(luggage_image, "luggage", order_id, "Luggage image")

    order = db.insert("orders", build_new_order_record(
        order_id=order_id,
        now=now,
        name=name,
        phone=phone,
        companion_count=companion_count,
        suitcase_qty=suitcase_qty,
        backpack_qty=backpack_qty,
        set_qty=pricing.set_qty,
        pickup_at=pickup_at,
        expected_storage_days=expected_storage_days,
        price_per_day=pricing.price_per_day,
        discount_rate=discount_rate,
        prepaid_amount=prepaid_amount,
        payment_method=payment_method,
        tag_no=build_tag_no(db, now),
        id_image_url=id_image_path,
        luggage_image_url=luggage_image_path,
        manual_entry=False,
        staff_id=None,
    ))

    return RedirectResponse(
        url=f"/customer/orders/{order_id}?lang={lang}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.get("/customer/orders/{order_id}", response_class=HTMLResponse)
def customer_success(
    request: Request,
    order_id: str,
    lang: str = "ko",
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    normalized_lang, t = get_translations(lang)
    amount_text = format_yen(order.prepaid_amount)
    completion_messages = load_completion_messages(db)
    primary_template = completion_messages["primary"].get(normalized_lang) or completion_messages["primary"]["ko"]
    secondary_template = completion_messages["secondary"].get(normalized_lang) or completion_messages["secondary"]["ko"]
    primary_message = primary_template.replace("{amount}", amount_text)
    secondary_message = secondary_template.replace("{amount}", amount_text)

    return templates.TemplateResponse(
        "customer_success.html",
        {
            "request": request,
            "lang": normalized_lang,
            "t": t,
            "order": order,
            "created_jst": to_jst_datetime(order.created_at),
            "pickup_jst": to_jst_datetime(order.expected_pickup_at),
            "amount_text": amount_text,
            "success_primary_message": primary_message,
            "success_secondary_message": secondary_message,
        },
    )


@app.get("/api/orders/{order_id}", response_model=OrderSummaryResponse)
def api_order(order_id: str, db: SupabaseDB = Depends(get_db)) -> OrderSummaryResponse:
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return order_to_response(order)


@app.get("/auth/google")
def auth_google(request: Request):
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()
    request.session["oauth_code_verifier"] = code_verifier
    base = APP_BASE_URL or str(request.base_url).rstrip("/")
    params = urlencode({
        "provider": "google",
        "redirect_to": f"{base}/auth/callback",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "flow_type": "pkce",
    })
    return RedirectResponse(url=f"{SUPABASE_URL}/auth/v1/authorize?{params}", status_code=302)


@app.get("/auth/callback")
def auth_callback(
    request: Request,
    code: Optional[str] = None,
    error: Optional[str] = None,
    db: SupabaseDB = Depends(get_db),
):
    if error or not code:
        return RedirectResponse(url="/staff/login?oauth_error=oauth_failed", status_code=303)

    code_verifier = request.session.pop("oauth_code_verifier", None)
    if not code_verifier:
        return RedirectResponse(url="/staff/login?oauth_error=state_missing", status_code=303)

    resp = httpx.post(
        f"{SUPABASE_URL}/auth/v1/token",
        params={"grant_type": "pkce"},
        json={"auth_code": code, "code_verifier": code_verifier},
        headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json"},
        timeout=10,
    )
    if resp.status_code != 200:
        return RedirectResponse(url="/staff/login?oauth_error=exchange_failed", status_code=303)

    user_id = (resp.json().get("user") or {}).get("id")
    if not user_id:
        return RedirectResponse(url="/staff/login?oauth_error=no_user", status_code=303)

    profile = db.get("user_profiles", "id", str(user_id))
    if not profile or not profile.is_active:
        return RedirectResponse(url="/staff/login?oauth_error=access_denied", status_code=303)

    request.session["user_id"] = str(user_id)
    return RedirectResponse(url="/staff/dashboard", status_code=303)


@app.get("/staff/login", response_class=HTMLResponse)
def staff_login_page(request: Request, oauth_error: Optional[str] = None) -> HTMLResponse:
    error_msg = OAUTH_ERROR_MESSAGES.get(oauth_error) if oauth_error else None
    return templates.TemplateResponse("staff_login.html", {"request": request, "error": error_msg})


@app.post("/staff/login", response_class=HTMLResponse)
def staff_login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: SupabaseDB = Depends(get_db),
):
    try:
        auth_client = supabase.create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        response = auth_client.auth.sign_in_with_password({"email": email.strip(), "password": password.strip()})
        user = response.user
        if not user:
            raise ValueError("No user returned")
    except Exception:
        return templates.TemplateResponse(
            "staff_login.html",
            {"request": request, "error": "로그인 실패: 이메일 또는 비밀번호를 확인하세요."},
            status_code=401,
        )

    profile = db.get("user_profiles", "id", str(user.id))
    if not profile or not profile.is_active:
        return templates.TemplateResponse(
            "staff_login.html",
            {"request": request, "error": "접근 권한이 없습니다."},
            status_code=403,
        )

    request.session["user_id"] = str(user.id)
    return RedirectResponse(url="/staff/dashboard", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/logout")
def staff_logout(request: Request) -> RedirectResponse:
    request.session.clear()
    return RedirectResponse(url="/staff/login", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/dashboard", response_class=HTMLResponse)
def staff_dashboard(
    request: Request,
    status_filter: list[str] = Query(default=[]),
    show_all_picked_up: bool = False,
    q: str = "",
    retention_msg: str = "",
    retention_err: str = "",
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    now_utc = utc_now()
    now_jst = now_utc.astimezone(JST)
    manual_default_pickup = next_pickup_default_jst(now_utc)
    selected_status_filters = normalize_status_filters(status_filter)
    orders = query_staff_orders(
        db,
        selected_status_filters,
        q,
        limit=500,
        show_all_picked_up=show_all_picked_up,
    )
    return templates.TemplateResponse(
        "staff_dashboard.html",
        {
            "request": request,
            "orders": orders,
            "selected_status_filters": selected_status_filters,
            "q": q,
            "show_all_picked_up": show_all_picked_up,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "dashboard", staff.is_admin),
            "now_jst": now_jst,
            "manual_default_pickup_date": manual_default_pickup.strftime("%Y-%m-%d"),
            "manual_default_pickup_time": manual_default_pickup.strftime("%H:%M"),
            "JST": JST,
            "max_bag_qty": MAX_BAG_QTY,
            "display_payment_method": display_payment_method,
            "display_flying_pass_tier": display_flying_pass_tier,
            "to_jst_datetime": to_jst_datetime,
            "flying_pass_tiers_json": build_flying_pass_tiers_json(),
            "retention_msg": retention_msg.strip(),
            "retention_err": retention_err.strip(),
        },
    )


@app.get("/staff/lost-found", response_class=HTMLResponse)
def staff_lost_found_page(
    request: Request,
    edit_id: Optional[int] = None,
    q: str = "",
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    search_query = q.strip()
    entry_query = db.query("lost_found_entries")
    if search_query:
        search_like = f"%{search_query}%"
        entry_query = entry_query.filter_or([
            ("item_name", "LIKE", search_like),
            ("found_location", "LIKE", search_like),
            ("claimed_by", "LIKE", search_like),
            ("note", "LIKE", search_like),
            ("status", "LIKE", search_like),
        ])

    entries = (
        entry_query
        .order_by("found_at DESC", "entry_id DESC")
        .limit(300)
        .all()
    )
    editing_entry = db.get("lost_found_entries", "entry_id", edit_id) if edit_id else None
    now_jst = utc_now().astimezone(JST)
    return templates.TemplateResponse(
        "staff_lost_found.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "lost_found", staff.is_admin),
            "entries": entries,
            "now_jst": now_jst,
            "default_found_at": now_jst.strftime("%Y-%m-%dT%H:%M"),
            "editing_entry": editing_entry,
            "display_lost_found_status": display_lost_found_status,
            "to_jst_datetime": to_jst_datetime,
            "LOST_FOUND_STATUSES": LOST_FOUND_STATUSES,
            "q": search_query,
        },
    )


@app.post("/staff/lost-found")
def staff_lost_found_create(
    request: Request,
    found_at: str = Form(...),
    item_name: str = Form(...),
    quantity: int = Form(1),
    found_location: str = Form(...),
    status_value: str = Form("STORED"),
    claimed_by: str = Form(""),
    note: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)

    if not item_name.strip():
        raise HTTPException(status_code=400, detail="Item name is required.")
    if not found_location.strip():
        raise HTTPException(status_code=400, detail="Found location is required.")
    if quantity < 1 or quantity > 99:
        raise HTTPException(status_code=400, detail="Quantity must be 1~99.")

    normalized_status = status_value.strip().upper()
    if normalized_status not in LOST_FOUND_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid lost-found status.")

    found_at_utc = parse_pickup_datetime(found_at)

    db.insert("lost_found_entries", {
        "found_at": found_at_utc,
        "item_name": item_name.strip(),
        "quantity": quantity,
        "found_location": found_location.strip(),
        "status": normalized_status,
        "claimed_by": claimed_by.strip() or None,
        "note": note.strip() or None,
        "staff_id": staff.staff_id,
        "created_at": utc_now(),
    })
    return RedirectResponse(url="/staff/lost-found", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/lost-found/{entry_id}/update")
def staff_lost_found_update(
    request: Request,
    entry_id: int,
    found_at: str = Form(...),
    item_name: str = Form(...),
    quantity: int = Form(1),
    found_location: str = Form(...),
    status_value: str = Form(...),
    claimed_by: str = Form(""),
    note: str = Form(""),
    q: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    entry = db.get("lost_found_entries", "entry_id", entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")

    if not item_name.strip():
        raise HTTPException(status_code=400, detail="Item name is required.")
    if not found_location.strip():
        raise HTTPException(status_code=400, detail="Found location is required.")
    if quantity < 1 or quantity > 99:
        raise HTTPException(status_code=400, detail="Quantity must be 1~99.")

    normalized_status = status_value.strip().upper()
    if normalized_status not in LOST_FOUND_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid lost-found status.")

    entry.found_at = parse_pickup_datetime(found_at)
    entry.item_name = item_name.strip()
    entry.quantity = quantity
    entry.found_location = found_location.strip()
    entry.status = normalized_status
    entry.claimed_by = claimed_by.strip() or None
    entry.note = note.strip() or None
    entry.staff_id = staff.staff_id
    db.update(entry)
    redirect_url = "/staff/lost-found"
    if q.strip():
        redirect_url = f"{redirect_url}?{urlencode({'q': q.strip()})}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/lost-found/{entry_id}/delete")
def staff_lost_found_delete(
    request: Request,
    entry_id: int,
    q: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    _ = ensure_staff(request, db)
    entry = db.get("lost_found_entries", "entry_id", entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    db.delete_row("lost_found_entries", "entry_id", entry.entry_id)
    redirect_url = "/staff/lost-found"
    if q.strip():
        redirect_url = f"{redirect_url}?{urlencode({'q': q.strip()})}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/handover", response_class=HTMLResponse)
def staff_handover_page(
    request: Request,
    edit_id: Optional[int] = None,
    q: str = "",
    unread_only: bool = False,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    ctx = build_handover_context(
        db, staff, edit_id=edit_id, search_query=q.strip(), unread_only=unread_only,
    )
    return templates.TemplateResponse(
        "staff_handover.html",
        {"request": request, **ctx},
    )


@app.post("/staff/handover")
def staff_handover_create(
    request: Request,
    category: str = Form("NOTICE"),
    title: str = Form(...),
    content: str = Form(...),
    is_pinned: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)

    normalized_category = category.strip().upper()
    if normalized_category not in NOTE_CATEGORIES:
        raise HTTPException(status_code=400, detail="Invalid category.")
    if not title.strip():
        raise HTTPException(status_code=400, detail="Title is required.")
    if not content.strip():
        raise HTTPException(status_code=400, detail="Content is required.")

    db.insert("handover_notes", {
        "category": normalized_category,
        "title": title.strip(),
        "content": content.strip(),
        "is_pinned": is_pinned == "on",
        "staff_id": staff.staff_id,
        "created_at": utc_now(),
    })
    return RedirectResponse(url="/staff/handover", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/handover/{note_id}/update")
def staff_handover_update(
    request: Request,
    note_id: int,
    category: str = Form("NOTICE"),
    title: str = Form(...),
    content: str = Form(...),
    is_pinned: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    _ = ensure_staff(request, db)
    note = db.get("handover_notes", "note_id", note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found.")

    normalized_category = category.strip().upper()
    if normalized_category not in NOTE_CATEGORIES:
        raise HTTPException(status_code=400, detail="Invalid category.")
    if not title.strip():
        raise HTTPException(status_code=400, detail="Title is required.")
    if not content.strip():
        raise HTTPException(status_code=400, detail="Content is required.")

    note.category = normalized_category
    note.title = title.strip()
    note.content = content.strip()
    note.is_pinned = is_pinned == "on"
    db.update(note)
    return RedirectResponse(url="/staff/handover", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/handover/{note_id}/delete")
def staff_handover_delete(
    request: Request,
    note_id: int,
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    _ = ensure_staff(request, db)
    note = db.get("handover_notes", "note_id", note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found.")

    db.delete_where("handover_comments", [("note_id", "=", note_id)])
    db.delete_where("handover_reads", [("note_id", "=", note_id)])
    db.delete_row("handover_notes", "note_id", note_id)
    return RedirectResponse(url="/staff/handover", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/handover/{note_id}/comments")
def staff_handover_comment_create(
    request: Request,
    note_id: int,
    content: str = Form(...),
    q: str = Form(""),
    unread_only: str = Form("0"),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    note = db.get("handover_notes", "note_id", note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found.")

    normalized_content = content.strip()
    if not normalized_content:
        raise HTTPException(status_code=400, detail="Comment is required.")
    if len(normalized_content) > 1000:
        raise HTTPException(status_code=400, detail="Comment must be 1000 characters or less.")

    db.insert("handover_comments", {
        "note_id": note_id,
        "staff_id": staff.staff_id,
        "content": normalized_content,
        "created_at": utc_now(),
    })

    query: dict[str, str] = {}
    if q.strip():
        query["q"] = q.strip()
    if unread_only.strip() in {"1", "true", "on", "yes"}:
        query["unread_only"] = "1"
    redirect_url = "/staff/handover"
    if query:
        redirect_url = f"{redirect_url}?{urlencode(query)}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/handover/comments/{comment_id}/delete")
def staff_handover_comment_delete(
    request: Request,
    comment_id: int,
    q: str = Form(""),
    unread_only: str = Form("0"),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    comment = db.get("handover_comments", "comment_id", comment_id)
    if comment is None:
        raise HTTPException(status_code=404, detail="Comment not found.")
    if not staff.is_admin and comment.staff_id != staff.staff_id:
        raise HTTPException(status_code=403, detail="Not allowed to delete this comment.")

    db.delete_row("handover_comments", "comment_id", comment_id)

    query: dict[str, str] = {}
    if q.strip():
        query["q"] = q.strip()
    if unread_only.strip() in {"1", "true", "on", "yes"}:
        query["unread_only"] = "1"
    redirect_url = "/staff/handover"
    if query:
        redirect_url = f"{redirect_url}?{urlencode(query)}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/handover/{note_id}/read")
def staff_handover_read_toggle(
    request: Request,
    note_id: int,
    is_read: str = Form("0"),
    q: str = Form(""),
    unread_only: str = Form("0"),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    note = db.get("handover_notes", "note_id", note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found.")

    should_mark_read = is_read.strip() in {"1", "true", "on", "yes"}
    existing = (
        db.query("handover_reads")
        .filter(("note_id", "=", note_id), ("staff_id", "=", staff.staff_id))
        .all()
    )

    if should_mark_read and not existing:
        db.insert("handover_reads", {
            "note_id": note_id,
            "staff_id": staff.staff_id,
            "read_at": utc_now(),
        })
    elif not should_mark_read and existing:
        db.delete_where("handover_reads", [("note_id", "=", note_id), ("staff_id", "=", staff.staff_id)])

    reads = (
        db.query("handover_reads")
        .filter(("note_id", "=", note_id))
        .order_by("read_at ASC", "read_id ASC")
        .all()
    )
    staff_ids = {row.staff_id for row in reads}
    staff_name_by_id = resolve_staff_names(db, staff_ids)
    reader_names: list[str] = []
    for read in reads:
        name = staff_name_by_id.get(read.staff_id, f"ID {read.staff_id}")
        if name not in reader_names:
            reader_names.append(name)

    is_ajax = request.headers.get("x-requested-with", "").lower() == "xmlhttprequest"
    if is_ajax:
        return JSONResponse(
            {
                "note_id": note_id,
                "is_read": should_mark_read,
                "reader_names": reader_names,
            }
        )

    redirect_query = q.strip()
    redirect_url = "/staff/handover"
    query: dict[str, str] = {}
    if redirect_query:
        query["q"] = redirect_query
    if unread_only.strip() in {"1", "true", "on", "yes"}:
        query["unread_only"] = "1"
    if query:
        redirect_url = f"{redirect_url}?{urlencode(query)}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/cash-closing", response_class=HTMLResponse)
def staff_cash_closing_page(
    request: Request,
    edit_id: Optional[int] = None,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    ctx = build_cash_closing_context(db, staff, edit_id=edit_id)
    return templates.TemplateResponse(
        "staff_cash_closing.html",
        {"request": request, **ctx},
    )


@app.post("/staff/cash-closing")
def staff_cash_closing_create(
    request: Request,
    business_date: str = Form(...),
    closing_type: str = Form("MORNING_HANDOVER"),
    count_10000: int = Form(0),
    count_5000: int = Form(0),
    count_2000: int = Form(0),
    count_1000: int = Form(0),
    count_500: int = Form(0),
    count_100: int = Form(0),
    count_50: int = Form(0),
    count_10: int = Form(0),
    count_5: int = Form(0),
    count_1: int = Form(0),
    actual_qr_amount: int = Form(-1),
    owner_name: str = Form(""),
    note: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)

    _ = business_date_range_utc(business_date)
    normalized_closing_type = parse_cash_closing_type(closing_type)
    existing_row = (
        db.query("cash_closings")
        .filter(
            ("business_date", "=", business_date),
            ("closing_type", "=", normalized_closing_type),
        )
        .first()
    )
    if existing_row is not None:
        return RedirectResponse(
            url=f"/staff/cash-closing?edit_id={existing_row.closing_id}",
            status_code=status.HTTP_303_SEE_OTHER,
        )

    counts = parse_denomination_counts(
        count_10000, count_5000, count_2000, count_1000, count_500,
        count_100, count_50, count_10, count_5, count_1,
    )
    computed = build_cash_closing_fields(counts, actual_qr_amount, db, business_date)

    row = db.insert("cash_closings", {
        "business_date": business_date,
        "closing_type": normalized_closing_type,
        "workflow_status": "DRAFT",
        "count_10000": count_10000,
        "count_5000": count_5000,
        "count_2000": count_2000,
        "count_1000": count_1000,
        "count_500": count_500,
        "count_100": count_100,
        "count_50": count_50,
        "count_10": count_10,
        "count_5": count_5,
        "count_1": count_1,
        **computed,
        "submitted_by_staff_id": None,
        "submitted_at": None,
        "verified_by_staff_id": None,
        "verified_at": None,
        "check_cash_match": False,
        "check_qr_match": False,
        "check_pending_items": False,
        "check_handover_note": False,
        "owner_name": owner_name.strip() or staff.name,
        "note": note.strip() or None,
        "staff_id": staff.staff_id,
    })
    create_cash_closing_audit(
        db,
        row,
        action="CREATE",
        staff_id=staff.staff_id,
        payload={
            "business_date": row.business_date,
            "closing_type": row.closing_type,
            "workflow_status": row.workflow_status,
            "total_amount": row.total_amount,
            "difference_amount": row.difference_amount,
            "qr_difference_amount": row.qr_difference_amount,
        },
    )
    return RedirectResponse(url="/staff/cash-closing", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/cash-closing/{closing_id}/update")
def staff_cash_closing_update(
    request: Request,
    closing_id: int,
    business_date: str = Form(...),
    closing_type: str = Form("MORNING_HANDOVER"),
    count_10000: int = Form(0),
    count_5000: int = Form(0),
    count_2000: int = Form(0),
    count_1000: int = Form(0),
    count_500: int = Form(0),
    count_100: int = Form(0),
    count_50: int = Form(0),
    count_10: int = Form(0),
    count_5: int = Form(0),
    count_1: int = Form(0),
    actual_qr_amount: int = Form(-1),
    owner_name: str = Form(""),
    note: str = Form(""),
    admin_edit_reason: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    row = db.get("cash_closings", "closing_id", closing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Cash closing not found.")

    _ = business_date_range_utc(business_date)
    normalized_closing_type = parse_cash_closing_type(closing_type)
    ensure_unique_cash_closing_type(
        db,
        business_date,
        normalized_closing_type,
        exclude_closing_id=closing_id,
    )

    was_locked = row.workflow_status == "LOCKED"
    was_submitted = row.workflow_status == "SUBMITTED"
    if was_locked and not staff.is_admin:
        raise HTTPException(status_code=403, detail="잠금된 정산은 관리자만 수정할 수 있습니다.")
    if was_locked and not admin_edit_reason.strip():
        raise HTTPException(status_code=400, detail="잠금 해제 수정 사유를 입력해 주세요.")
    if (
        was_submitted
        and not staff.is_admin
        and row.submitted_by_staff_id is not None
        and row.submitted_by_staff_id != staff.staff_id
    ):
        raise HTTPException(status_code=403, detail="제출된 정산은 제출자 또는 관리자만 수정할 수 있습니다.")

    counts = parse_denomination_counts(
        count_10000, count_5000, count_2000, count_1000, count_500,
        count_100, count_50, count_10, count_5, count_1,
    )
    computed = build_cash_closing_fields(counts, actual_qr_amount, db, business_date)

    row.business_date = business_date
    row.closing_type = normalized_closing_type
    row.count_10000 = count_10000
    row.count_5000 = count_5000
    row.count_2000 = count_2000
    row.count_1000 = count_1000
    row.count_500 = count_500
    row.count_100 = count_100
    row.count_50 = count_50
    row.count_10 = count_10
    row.count_5 = count_5
    row.count_1 = count_1
    for field_name, field_value in computed.items():
        setattr(row, field_name, field_value)
    row.workflow_status = "DRAFT"
    row.submitted_by_staff_id = None
    row.submitted_at = None
    row.verified_by_staff_id = None
    row.verified_at = None
    row.check_cash_match = False
    row.check_qr_match = False
    row.check_pending_items = False
    row.check_handover_note = False
    row.owner_name = owner_name.strip() or staff.name
    row.note = note.strip() or None
    row.staff_id = staff.staff_id

    create_cash_closing_audit(
        db,
        row,
        action="ADMIN_UNLOCK_UPDATE" if was_locked else "UPDATE",
        staff_id=staff.staff_id,
        reason=admin_edit_reason,
        payload={
            "business_date": row.business_date,
            "closing_type": row.closing_type,
            "workflow_status": row.workflow_status,
            "total_amount": row.total_amount,
            "difference_amount": row.difference_amount,
            "qr_difference_amount": row.qr_difference_amount,
        },
    )
    db.update(row)
    return RedirectResponse(url="/staff/cash-closing", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/cash-closing/{closing_id}/submit")
def staff_cash_closing_submit(
    request: Request,
    closing_id: int,
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    row = db.get("cash_closings", "closing_id", closing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Cash closing not found.")
    if row.workflow_status == "LOCKED":
        raise HTTPException(status_code=400, detail="이미 잠금된 정산입니다.")

    row.workflow_status = "SUBMITTED"
    row.submitted_by_staff_id = staff.staff_id
    row.submitted_at = utc_now()
    row.verified_by_staff_id = None
    row.verified_at = None
    row.check_cash_match = False
    row.check_qr_match = False
    row.check_pending_items = False
    row.check_handover_note = False
    row.staff_id = staff.staff_id

    create_cash_closing_audit(
        db,
        row,
        action="SUBMIT",
        staff_id=staff.staff_id,
        payload={
            "workflow_status": row.workflow_status,
            "submitted_by_staff_id": row.submitted_by_staff_id,
        },
    )
    db.update(row)
    return RedirectResponse(url="/staff/cash-closing", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/cash-closing/{closing_id}/verify-lock")
def staff_cash_closing_verify_lock(
    request: Request,
    closing_id: int,
    check_cash_match: str = Form(""),
    check_qr_match: str = Form(""),
    check_pending_items: str = Form(""),
    check_handover_note: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    row = db.get("cash_closings", "closing_id", closing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Cash closing not found.")
    if row.workflow_status != "SUBMITTED":
        raise HTTPException(status_code=400, detail="제출된 정산만 확인 잠금할 수 있습니다.")
    if not row.submitted_by_staff_id:
        raise HTTPException(status_code=400, detail="제출자 정보가 없습니다.")
    if row.submitted_by_staff_id == staff.staff_id:
        raise HTTPException(status_code=400, detail="작성자와 확인자는 동일할 수 없습니다.")

    checks = {
        "check_cash_match": check_cash_match == "on",
        "check_qr_match": check_qr_match == "on",
        "check_pending_items": check_pending_items == "on",
        "check_handover_note": check_handover_note == "on",
    }
    if not all(checks.values()):
        raise HTTPException(status_code=400, detail="체크리스트를 모두 확인해야 잠금할 수 있습니다.")

    row.check_cash_match = True
    row.check_qr_match = True
    row.check_pending_items = True
    row.check_handover_note = True
    row.workflow_status = "LOCKED"
    row.verified_by_staff_id = staff.staff_id
    row.verified_at = utc_now()
    row.staff_id = staff.staff_id

    create_cash_closing_audit(
        db,
        row,
        action="VERIFY_LOCK",
        staff_id=staff.staff_id,
        payload={
            "workflow_status": row.workflow_status,
            "submitted_by_staff_id": row.submitted_by_staff_id,
            "verified_by_staff_id": row.verified_by_staff_id,
            **checks,
        },
    )
    db.update(row)
    return RedirectResponse(url=f"/staff/cash-closing/{closing_id}", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/cash-closing/{closing_id}", response_class=HTMLResponse)
def staff_cash_closing_detail(
    request: Request,
    closing_id: int,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    row = db.get("cash_closings", "closing_id", closing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Cash closing not found.")

    audits = (
        db.query("cash_closing_audits")
        .filter(("closing_id", "=", row.closing_id))
        .order_by("created_at DESC", "audit_id DESC")
        .limit(60)
        .all()
    )
    staff_ids = {value for value in (row.staff_id, row.submitted_by_staff_id, row.verified_by_staff_id) if value}
    staff_ids.update(audit.staff_id for audit in audits if audit.staff_id)
    staff_name_by_id = resolve_staff_names(db, staff_ids)

    created_by_staff_id = row.staff_id
    for audit in reversed(audits):
        if audit.action == "CREATE" and audit.staff_id:
            created_by_staff_id = audit.staff_id
            break
    created_by_name = staff_name_by_id.get(created_by_staff_id or -1, "-") if created_by_staff_id else "-"
    last_modified_staff_name = staff_name_by_id.get(row.staff_id or -1, "-") if row.staff_id else "-"
    submitted_by_name = staff_name_by_id.get(row.submitted_by_staff_id or -1, "-") if row.submitted_by_staff_id else "-"
    verified_by_name = staff_name_by_id.get(row.verified_by_staff_id or -1, "-") if row.verified_by_staff_id else "-"
    can_verify = (
        row.workflow_status == "SUBMITTED"
        and row.submitted_by_staff_id is not None
        and row.submitted_by_staff_id != staff.staff_id
    )

    return templates.TemplateResponse(
        "staff_cash_closing_detail.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "cash_closing", staff.is_admin),
            "row": row,
            "created_by_name": created_by_name,
            "last_modified_staff_name": last_modified_staff_name,
            "submitted_by_name": submitted_by_name,
            "verified_by_name": verified_by_name,
            "can_verify": can_verify,
            "audits": audits,
            "staff_name_by_id": staff_name_by_id,
            "to_jst_datetime": to_jst_datetime,
            "COIN_BILL_DENOMS": COIN_BILL_DENOMS,
            "display_cash_closing_type": display_cash_closing_type,
            "display_cash_closing_status": display_cash_closing_status,
            "cash_closing_status_pill_class": cash_closing_status_pill_class,
            "display_cash_closing_audit_action": display_cash_closing_audit_action,
        },
    )


@app.get("/staff/api/cash-closing/auto-sales")
def staff_cash_closing_auto_sales(
    request: Request,
    business_date: str,
    db: SupabaseDB = Depends(get_db),
) -> JSONResponse:
    _ = ensure_staff(request, db)
    sales = summarize_order_sales_for_date(db, business_date)
    return JSONResponse(sales)


@app.get("/staff/schedule", response_class=HTMLResponse)
def staff_schedule_page(
    request: Request,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    schedule_enabled = is_schedule_feature_enabled(db)
    schedule_embed_url = get_app_setting(db, SCHEDULE_GOOGLE_EMBED_URL_KEY, "")
    schedule_setting_row = db.query("app_settings").filter(("setting_key", "=", SCHEDULE_GOOGLE_EMBED_URL_KEY)).first()
    updated_by = "-"
    updated_at = "-"
    if schedule_setting_row:
        if schedule_setting_row.staff_id:
            updater = db.get("user_profiles", "id", schedule_setting_row.staff_id)
            if updater:
                updated_by = updater.name
            else:
                updated_by = f"ID {schedule_setting_row.staff_id}"
        updated_at = to_jst_datetime(schedule_setting_row.updated_at).strftime("%Y-%m-%d %H:%M")

    return templates.TemplateResponse(
        "staff_schedule.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "schedule", staff.is_admin),
            "schedule_enabled": schedule_enabled,
            "schedule_embed_url": schedule_embed_url,
            "schedule_updated_by": updated_by,
            "schedule_updated_at": updated_at,
        },
    )


@app.post("/staff/schedule")
def staff_schedule_update(
    request: Request,
    google_embed_url: str = Form(""),
    schedule_enabled: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = get_current_staff(request, db, require_admin=True)
    normalized_embed_url = normalize_schedule_embed_url(google_embed_url)
    is_enabled = schedule_enabled in {"1", "on", "true", "yes"}

    upsert_app_setting(
        db,
        SCHEDULE_GOOGLE_EMBED_URL_KEY,
        normalized_embed_url,
        staff.staff_id,
    )
    upsert_app_setting(
        db,
        SCHEDULE_FEATURE_ENABLED_KEY,
        "1" if is_enabled else "0",
        staff.staff_id,
    )
    return RedirectResponse(url="/staff/schedule", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/admin/sales", response_class=HTMLResponse)
def admin_sales_dashboard(
    request: Request,
    start_date: str = "",
    end_date: str = "",
    edit_rental_id: Optional[int] = None,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = get_current_staff(request, db, require_admin=True)
    today_jst = utc_now().astimezone(JST).date()
    default_start = today_jst.replace(day=1)

    selected_start = start_date.strip() or date_to_ymd(default_start)
    selected_end = end_date.strip() or date_to_ymd(today_jst)
    analytics = build_sales_analytics(db, selected_start, selected_end)

    rental_rows = (
        db.query("rental_daily_sales")
        .order_by("business_date DESC", "updated_at DESC", "rental_id DESC")
        .limit(400)
        .all()
    )
    editing_rental = db.get("rental_daily_sales", "rental_id", edit_rental_id) if edit_rental_id else None
    if edit_rental_id and editing_rental is None:
        raise HTTPException(status_code=404, detail="Rental row not found.")

    staff_ids = {row.staff_id for row in rental_rows if row.staff_id}
    if editing_rental and editing_rental.staff_id:
        staff_ids.add(editing_rental.staff_id)
    staff_name_by_id = resolve_staff_names(db, staff_ids)

    return templates.TemplateResponse(
        "staff_admin_sales.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "admin_sales", staff.is_admin),
            "start_date": selected_start,
            "end_date": selected_end,
            "daily_rows": analytics["daily_rows"],
            "monthly_rows": analytics["monthly_rows"],
            "totals": analytics["totals"],
            "range_days": analytics["range_days"],
            "avg_daily_revenue": analytics["avg_daily_revenue"],
            "avg_luggage_order_revenue": analytics["avg_luggage_order_revenue"],
            "chart": analytics["chart"],
            "rental_rows": rental_rows,
            "editing_rental": editing_rental,
            "staff_name_by_id": staff_name_by_id,
            "to_jst_datetime": to_jst_datetime,
        },
    )


@app.post("/staff/admin/sales/rental")
def admin_sales_rental_create_or_upsert(
    request: Request,
    business_date: str = Form(...),
    revenue_amount: int = Form(0),
    customer_count: int = Form(0),
    note: str = Form(""),
    start_date: str = Form(""),
    end_date: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = get_current_staff(request, db, require_admin=True)

    _ = business_date_range_utc(business_date)
    if revenue_amount < 0:
        raise HTTPException(status_code=400, detail="Revenue must be non-negative.")
    if customer_count < 0:
        raise HTTPException(status_code=400, detail="Customer count must be non-negative.")

    row = db.query("rental_daily_sales").filter(("business_date", "=", business_date)).first()
    if row is None:
        db.insert("rental_daily_sales", {
            "business_date": business_date,
            "revenue_amount": revenue_amount,
            "customer_count": customer_count,
            "note": note.strip() or None,
            "staff_id": staff.staff_id,
            "created_at": utc_now(),
        })
    else:
        row.revenue_amount = revenue_amount
        row.customer_count = customer_count
        row.note = note.strip() or None
        row.staff_id = staff.staff_id
        db.update(row)

    redirect_start = start_date.strip() or business_date
    redirect_end = end_date.strip() or business_date
    return RedirectResponse(
        url=build_admin_sales_redirect(redirect_start, redirect_end),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.post("/staff/admin/sales/rental/{rental_id}/update")
def admin_sales_rental_update(
    request: Request,
    rental_id: int,
    business_date: str = Form(...),
    revenue_amount: int = Form(0),
    customer_count: int = Form(0),
    note: str = Form(""),
    start_date: str = Form(""),
    end_date: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = get_current_staff(request, db, require_admin=True)
    row = db.get("rental_daily_sales", "rental_id", rental_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Rental row not found.")

    _ = business_date_range_utc(business_date)
    if revenue_amount < 0:
        raise HTTPException(status_code=400, detail="Revenue must be non-negative.")
    if customer_count < 0:
        raise HTTPException(status_code=400, detail="Customer count must be non-negative.")

    duplicated = (
        db.query("rental_daily_sales")
        .filter(("business_date", "=", business_date), ("rental_id", "!=", rental_id))
        .first()
    )
    if duplicated:
        raise HTTPException(status_code=400, detail="Same date row already exists.")

    row.business_date = business_date
    row.revenue_amount = revenue_amount
    row.customer_count = customer_count
    row.note = note.strip() or None
    row.staff_id = staff.staff_id
    db.update(row)

    redirect_start = start_date.strip() or business_date
    redirect_end = end_date.strip() or business_date
    return RedirectResponse(
        url=build_admin_sales_redirect(redirect_start, redirect_end),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.post("/staff/admin/sales/rental/{rental_id}/delete")
def admin_sales_rental_delete(
    request: Request,
    rental_id: int,
    start_date: str = Form(""),
    end_date: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    _ = get_current_staff(request, db, require_admin=True)
    row = db.get("rental_daily_sales", "rental_id", rental_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Rental row not found.")

    fallback_date = row.business_date
    db.delete_row("rental_daily_sales", "rental_id", rental_id)

    redirect_start = start_date.strip() or fallback_date
    redirect_end = end_date.strip() or fallback_date
    return RedirectResponse(
        url=build_admin_sales_redirect(redirect_start, redirect_end),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.get("/staff/admin/completion-message", response_class=HTMLResponse)
def admin_completion_message_page(
    request: Request,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = get_current_staff(request, db, require_admin=True)
    completion_messages = load_completion_messages(db)
    primary_message_ko = completion_messages["primary"]["ko"]
    secondary_message_ko = completion_messages["secondary"]["ko"]
    amount_preview = "¥4,800"
    preview_primary = {
        "ko": completion_messages["primary"]["ko"].replace("{amount}", amount_preview),
        "en": completion_messages["primary"]["en"].replace("{amount}", amount_preview),
        "ja": completion_messages["primary"]["ja"].replace("{amount}", amount_preview),
    }
    preview_secondary = {
        "ko": completion_messages["secondary"]["ko"].replace("{amount}", amount_preview),
        "en": completion_messages["secondary"]["en"].replace("{amount}", amount_preview),
        "ja": completion_messages["secondary"]["ja"].replace("{amount}", amount_preview),
    }

    rows = (
        db.query("app_settings")
        .filter(
            ("setting_key", "IN", [
                SUCCESS_PRIMARY_MESSAGE_KEYS["ko"],
                SUCCESS_SECONDARY_MESSAGE_KEYS["ko"],
            ])
        )
        .all()
    )
    updated_by: dict[str, str] = {}
    updated_at: dict[str, str] = {}
    if rows:
        staff_ids = {row.staff_id for row in rows if row.staff_id}
        staff_name_by_id = resolve_staff_names(db, staff_ids)
        for row in rows:
            if row.staff_id:
                updated_by[row.setting_key] = staff_name_by_id.get(row.staff_id, f"ID {row.staff_id}")
            updated_at[row.setting_key] = to_jst_datetime(row.updated_at).strftime("%Y-%m-%d %H:%M")

    return templates.TemplateResponse(
        "staff_completion_message.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "completion_message", staff.is_admin),
            "primary_message_ko": primary_message_ko,
            "secondary_message_ko": secondary_message_ko,
            "preview_primary": preview_primary,
            "preview_secondary": preview_secondary,
            "updated_by": updated_by,
            "updated_at": updated_at,
            "SUCCESS_PRIMARY_MESSAGE_KEY_KO": SUCCESS_PRIMARY_MESSAGE_KEYS["ko"],
            "SUCCESS_SECONDARY_MESSAGE_KEY_KO": SUCCESS_SECONDARY_MESSAGE_KEYS["ko"],
        },
    )


@app.post("/staff/admin/completion-message")
def admin_completion_message_update(
    request: Request,
    primary_message_ko: str = Form(...),
    secondary_message_ko: str = Form(...),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = get_current_staff(request, db, require_admin=True)
    if not primary_message_ko.strip():
        raise HTTPException(status_code=400, detail="Primary message is required.")
    if not secondary_message_ko.strip():
        raise HTTPException(status_code=400, detail="Secondary message is required.")

    resolved = build_completion_messages_from_ko(primary_message_ko, secondary_message_ko)
    for lang_code in ("ko", "en", "ja"):
        upsert_app_setting(
            db,
            SUCCESS_PRIMARY_MESSAGE_KEYS[lang_code],
            resolved["primary"][lang_code],
            staff.staff_id,
        )
        upsert_app_setting(
            db,
            SUCCESS_SECONDARY_MESSAGE_KEYS[lang_code],
            resolved["secondary"][lang_code],
            staff.staff_id,
        )
    return RedirectResponse(url="/staff/admin/completion-message", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/staff/admin/staff-accounts", response_class=HTMLResponse)
def admin_staff_accounts_page(
    request: Request,
    msg: str = "",
    err: str = "",
    focus_staff_id: Optional[str] = None,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = get_current_staff(request, db, require_admin=True)
    staff_rows = (
        db.query("user_profiles")
        .order_by("role DESC", "is_active DESC", "username ASC")
        .all()
    )
    active_admin_count = (
        db.query("user_profiles")
        .filter(("role", "=", "admin"), ("is_active", "=", True))
        .count()
    )

    google_user_ids: set[str] = set()
    try:
        auth_users = db.client.auth.admin.list_users()
        for u in auth_users:
            providers = (u.app_metadata or {}).get("providers", [])
            if "google" in providers:
                google_user_ids.add(u.id)
    except Exception:
        pass

    return templates.TemplateResponse(
        "staff_admin_accounts.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "staff_accounts", staff.is_admin),
            "staff_rows": staff_rows,
            "active_admin_count": active_admin_count,
            "google_user_ids": google_user_ids,
            "msg": msg.strip(),
            "err": err.strip(),
            "focus_staff_id": focus_staff_id,
            "to_jst_datetime": to_jst_datetime,
        },
    )


@app.post("/staff/admin/staff-accounts")
def admin_staff_accounts_create(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    display_name: str = Form(""),
    is_admin: str = Form("0"),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    _ = get_current_staff(request, db, require_admin=True)
    resolved_email = email.strip()
    resolved_display = display_name.strip() or resolved_email.split("@")[0]
    resolved_role = "admin" if is_admin in {"1", "on", "true", "yes"} else "editor"

    if not resolved_email:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="이메일을 입력해주세요."),
            status_code=status.HTTP_303_SEE_OTHER,
        )
    if len(password.strip()) < 6:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="비밀번호는 6자리 이상 입력해주세요."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    try:
        admin_client = supabase.create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        auth_resp = admin_client.auth.admin.create_user({
            "email": resolved_email,
            "password": password.strip(),
            "email_confirm": True,
        })
        new_user = auth_resp.user
    except Exception as e:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err=f"계정 생성 실패: {e}"),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    try:
        db.insert("user_profiles", {
            "id": str(new_user.id),
            "username": resolved_email.split("@")[0],
            "display_name": resolved_display,
            "role": resolved_role,
            "is_active": True,
        })
    except Exception as e:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err=f"프로필 생성 실패: {e}"),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    return RedirectResponse(
        url=build_staff_accounts_redirect(msg=f"{resolved_email} 계정을 생성했습니다."),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.post("/staff/admin/staff-accounts/{target_staff_id}/update")
def admin_staff_accounts_update(
    request: Request,
    target_staff_id: str,
    display_name: str = Form(...),
    is_admin: str = Form("0"),
    is_active: str = Form("1"),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    actor = get_current_staff(request, db, require_admin=True)
    row = db.get("user_profiles", "id", target_staff_id)
    if row is None:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="대상 계정을 찾을 수 없습니다."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    resolved_display = display_name.strip()
    resolved_role = "admin" if is_admin in {"1", "on", "true", "yes"} else "editor"
    resolved_active = is_active in {"1", "on", "true", "yes"}

    if not resolved_display:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="표시 이름을 입력해주세요."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    active_admin_count = (
        db.query("user_profiles")
        .filter(("role", "=", "admin"), ("is_active", "=", True))
        .count()
    )
    removing_last_active_admin = (
        row.role == "admin"
        and row.is_active
        and (resolved_role != "admin" or not resolved_active)
        and active_admin_count <= 1
    )
    if removing_last_active_admin:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="최소 1명의 활성 관리자 계정은 유지되어야 합니다."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    if str(row.id) == str(actor.id) and not resolved_active:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="현재 로그인한 본인 계정은 비활성화할 수 없습니다."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    row.display_name = resolved_display
    row.role = resolved_role
    row.is_active = resolved_active
    db.update(row)
    return RedirectResponse(
        url=build_staff_accounts_redirect(
            msg=f"{resolved_display} 계정을 수정했습니다.",
            focus_staff_id=str(row.id),
        ),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.post("/staff/admin/staff-accounts/{target_staff_id}/toggle-active")
def admin_staff_accounts_toggle_active(
    request: Request,
    target_staff_id: str,
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    actor = get_current_staff(request, db, require_admin=True)
    row = db.get("user_profiles", "id", target_staff_id)
    if row is None:
        return RedirectResponse(
            url=build_staff_accounts_redirect(err="대상 계정을 찾을 수 없습니다."),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    target_active = not bool(row.is_active)
    if not target_active and str(row.id) == str(actor.id):
        return RedirectResponse(
            url=build_staff_accounts_redirect(
                err="현재 로그인한 본인 계정은 잠글 수 없습니다.",
                focus_staff_id=str(row.id),
            ),
            status_code=status.HTTP_303_SEE_OTHER,
        )

    if row.role == "admin" and row.is_active and not target_active:
        active_admin_count = (
            db.query("user_profiles")
            .filter(("role", "=", "admin"), ("is_active", "=", True))
            .count()
        )
        if active_admin_count <= 1:
            return RedirectResponse(
                url=build_staff_accounts_redirect(
                    err="최소 1명의 활성 관리자 계정은 유지되어야 합니다.",
                    focus_staff_id=str(row.id),
                ),
                status_code=status.HTTP_303_SEE_OTHER,
            )

    row.is_active = target_active
    db.update(row)
    state_label = "복구" if target_active else "잠금"
    return RedirectResponse(
        url=build_staff_accounts_redirect(
            msg=f"{row.username} 계정을 {state_label}했습니다.",
            focus_staff_id=str(row.id),
        ),
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.get("/staff/api/orders")
def staff_orders_api(
    request: Request,
    status_filter: list[str] = Query(default=[]),
    show_all_picked_up: bool = False,
    q: str = "",
    db: SupabaseDB = Depends(get_db),
) -> JSONResponse:
    _ = ensure_staff(request, db)
    selected_status_filters = normalize_status_filters(status_filter)
    orders = query_staff_orders(
        db,
        selected_status_filters,
        q,
        limit=500,
        show_all_picked_up=show_all_picked_up,
    )
    return JSONResponse({"orders": [serialize_staff_order(order) for order in orders]})


@app.post("/staff/api/orders/{order_id}/inline-update")
def staff_inline_update_order(
    request: Request,
    order_id: str,
    payload: dict = Body(...),
    db: SupabaseDB = Depends(get_db),
) -> JSONResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    name = str(payload.get("name", "")).strip()
    phone = str(payload.get("phone", "")).strip()
    tag_no = str(payload.get("tag_no", "")).strip()
    note = str(payload.get("note", "")).strip()
    payment_method = str(payload.get("payment_method", "")).strip().upper()
    payment_status = str(payload.get("payment_status", "")).strip().upper()
    flying_pass_tier = normalize_flying_pass_tier(payload.get("flying_pass_tier"), order.flying_pass_tier)
    expected_pickup_raw = str(payload.get("expected_pickup_at", "")).strip()
    prepaid_raw = str(payload.get("prepaid_amount", "")).strip()
    submitted_prepaid_amount: Optional[int] = None

    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if payment_method and payment_method not in STAFF_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method.")
    if payment_status and payment_status not in {"PAYMENT_PENDING", "PAID"}:
        raise HTTPException(status_code=400, detail="Invalid payment status.")
    if not expected_pickup_raw:
        raise HTTPException(status_code=400, detail="Expected pickup time is required.")
    if prepaid_raw:
        try:
            submitted_prepaid_amount = int(float(prepaid_raw))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="요금은 숫자로 입력해주세요.") from exc
        if submitted_prepaid_amount < 0:
            raise HTTPException(status_code=400, detail="요금은 0 이상이어야 합니다.")

    expected_pickup = parse_pickup_datetime(expected_pickup_raw)
    try:
        validate_pickup_time_window(expected_pickup)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    order.name = name
    if phone:
        order.phone = phone
    order.expected_pickup_at = expected_pickup

    if tag_no:
        order.tag_no = tag_no
    elif not order.tag_no:
        order.tag_no = build_tag_no(db, order.created_at)

    if payment_method:
        order.payment_method = payment_method
    elif not order.payment_method:
        order.payment_method = "PAY_QR"

    if order.status != "PICKED_UP":
        try:
            new_expected_days = calculate_storage_days(order.created_at, expected_pickup)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        recalculate_order_prepaid(
            order,
            expected_storage_days=new_expected_days,
            flying_pass_tier=flying_pass_tier,
            submitted_prepaid_amount=submitted_prepaid_amount,
        )
    elif submitted_prepaid_amount is not None or flying_pass_tier != normalize_flying_pass_tier(order.flying_pass_tier):
        raise HTTPException(status_code=400, detail="수령완료 건은 요금/멤버할인 수정이 불가합니다.")

    if order.status != "PICKED_UP" and payment_status in {"PAYMENT_PENDING", "PAID"}:
        order.status = payment_status

    auto_note = auto_pickup_note(order.created_at, expected_pickup)
    order.note = note if note else (auto_note or None)

    order.staff_id = staff.staff_id
    db.update(order)
    return JSONResponse({"order": serialize_staff_order(order)})


@app.post("/staff/api/orders/{order_id}/pickup")
def staff_inline_pickup_order(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
) -> JSONResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status != "PICKED_UP":
        try:
            apply_pickup_completion(order, staff.staff_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        db.update(order)

    return JSONResponse({"order": serialize_staff_order(order)})


@app.post("/staff/api/orders/{order_id}/undo-pickup")
def staff_inline_undo_pickup_order(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
) -> JSONResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status == "PICKED_UP":
        undo_pickup_completion(order, staff.staff_id)
        db.update(order)

    return JSONResponse({"order": serialize_staff_order(order)})


@app.get("/staff/orders/{order_id}", response_class=HTMLResponse)
def staff_order_detail(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
) -> HTMLResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    last_modified_staff = db.get("user_profiles", "id", order.staff_id) if order.staff_id else None

    return templates.TemplateResponse(
        "staff_order_detail.html",
        {
            "request": request,
            "staff": staff,
            "staff_menu_items": build_staff_menu(db, "dashboard", staff.is_admin),
            "order": order,
            "created_jst": to_jst_datetime(order.created_at),
            "updated_jst": to_jst_datetime(order.updated_at),
            "expected_pickup_jst": to_jst_datetime(order.expected_pickup_at),
            "actual_pickup_jst": to_jst_datetime(order.actual_pickup_at) if order.actual_pickup_at else None,
            "last_modified_staff": last_modified_staff,
            "display_flying_pass_tier": display_flying_pass_tier,
        },
    )


@app.post("/staff/orders/{order_id}/mark-paid")
def staff_mark_paid(
    request: Request,
    order_id: str,
    payment_method: str = Form(...),
    tag_no: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status not in {"PAYMENT_PENDING", "PAID"}:
        raise HTTPException(status_code=400, detail="Only pending orders can be paid.")

    method = payment_method.strip().upper()
    if method not in STAFF_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method.")

    order.status = "PAID"
    order.payment_method = method
    if tag_no.strip():
        order.tag_no = tag_no.strip()
    elif not order.tag_no:
        order.tag_no = build_tag_no(db, order.created_at)
    order.staff_id = staff.staff_id
    db.update(order)
    return RedirectResponse(url=f"/staff/orders/{order_id}", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/orders/{order_id}/update")
def staff_update_order(
    request: Request,
    order_id: str,
    name: str = Form(...),
    phone: str = Form(...),
    tag_no: str = Form(""),
    note: str = Form(""),
    expected_pickup_at: str = Form(...),
    status_value: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    normalized_status = status_value.strip().upper()
    if normalized_status and normalized_status not in {"PAYMENT_PENDING", "PAID", "PICKED_UP"}:
        raise HTTPException(status_code=400, detail="Invalid status")

    expected_pickup = parse_pickup_datetime(expected_pickup_at)
    try:
        validate_pickup_time_window(expected_pickup)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    order.name = name.strip()
    order.phone = phone.strip()
    requested_tag_no = tag_no.strip()
    if requested_tag_no:
        order.tag_no = requested_tag_no
    elif not order.tag_no:
        order.tag_no = build_tag_no(db, order.created_at)
    order.note = note.strip() if note.strip() else None
    order.expected_pickup_at = expected_pickup

    if order.status != "PICKED_UP":
        try:
            new_expected_days = calculate_storage_days(order.created_at, expected_pickup)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        recalculate_order_prepaid(order, expected_storage_days=new_expected_days)

    if normalized_status == "PICKED_UP" and order.status != "PICKED_UP":
        raise HTTPException(status_code=400, detail="Use pickup action to set PICKED_UP.")

    if order.status == "PICKED_UP" and normalized_status == "PAID":
        order.status = "PAID"
    elif order.status in {"PAYMENT_PENDING", "PAID"} and normalized_status in {"PAYMENT_PENDING", "PAID"}:
        order.status = normalized_status

    order.staff_id = staff.staff_id
    db.update(order)
    return RedirectResponse(url=f"/staff/orders/{order_id}", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/orders/{order_id}/mark-picked-up")
def staff_mark_picked_up(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        apply_pickup_completion(order, staff.staff_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db.update(order)
    return RedirectResponse(url=f"/staff/orders/{order_id}", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/orders/{order_id}/undo-picked-up")
def staff_undo_picked_up(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status == "PICKED_UP":
        undo_pickup_completion(order, staff.staff_id)
        db.update(order)

    return RedirectResponse(url=f"/staff/orders/{order_id}", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/staff/orders/manual")
def create_manual_order(
    request: Request,
    name: str = Form(...),
    phone: str = Form(...),
    suitcase_qty: int = Form(...),
    backpack_qty: int = Form(...),
    expected_pickup_at: str = Form(""),
    expected_pickup_date: str = Form(""),
    expected_pickup_time: str = Form(""),
    db: SupabaseDB = Depends(get_db),
) -> RedirectResponse:
    staff = ensure_staff(request, db)

    validate_bag_quantities(suitcase_qty, backpack_qty)

    expected_pickup_raw = expected_pickup_at.strip()
    if not expected_pickup_raw and expected_pickup_date.strip() and expected_pickup_time.strip():
        expected_pickup_raw = f"{expected_pickup_date.strip()}T{expected_pickup_time.strip()}"
    if not expected_pickup_raw:
        raise HTTPException(status_code=400, detail="Expected pickup date/time is required.")

    now = utc_now()
    pickup_at = parse_pickup_datetime(expected_pickup_raw)
    try:
        validate_pickup_time_window(pickup_at)
        expected_storage_days = calculate_storage_days(now, pickup_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if pickup_at < now:
        raise HTTPException(status_code=400, detail="Expected pickup time must be in the future.")

    pricing = calculate_price_per_day(suitcase_qty, backpack_qty)
    discount_rate, prepaid_amount = calculate_prepaid_amount(pricing.price_per_day, expected_storage_days)

    order_id = f"M-{build_order_id(db, now)}"
    order = db.insert("orders", build_new_order_record(
        order_id=order_id,
        now=now,
        name=name,
        phone=phone,
        companion_count=1,
        suitcase_qty=suitcase_qty,
        backpack_qty=backpack_qty,
        set_qty=pricing.set_qty,
        pickup_at=pickup_at,
        expected_storage_days=expected_storage_days,
        price_per_day=pricing.price_per_day,
        discount_rate=discount_rate,
        prepaid_amount=prepaid_amount,
        payment_method=None,
        tag_no=build_tag_no(db, now),
        manual_entry=True,
        staff_id=staff.staff_id,
    ))
    return RedirectResponse(url=f"/staff/orders/{order_id}", status_code=status.HTTP_303_SEE_OTHER)


def _serve_storage_image(storage_path: str) -> Response:
    """Download an image from Cloudflare R2 and return as an HTTP response."""
    data = r2_download(storage_path)
    ext = Path(storage_path).suffix.lower()
    content_type = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
    }.get(ext, "image/jpeg")
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "no-store", "Content-Disposition": "inline"},
    )


def _serve_order_image(
    request: Request,
    order_id: str,
    image_field: str,
    audit_action: str,
    db: SupabaseDB,
) -> Response:
    """Shared helper for serving order images (ID or luggage) with audit logging."""
    staff = ensure_staff(request, db)
    order = db.get("orders", "order_id", order_id)
    image_url = getattr(order, image_field, None) if order else None
    if order is None or not image_url:
        raise HTTPException(status_code=404, detail="Image not found")

    db.insert("audit_logs", {
        "order_id": order.order_id,
        "staff_id": staff.staff_id,
        "device_id": request.headers.get("x-device-id", request.client.host if request.client else "unknown"),
        "action": audit_action,
        "timestamp": utc_now(),
    })

    return _serve_storage_image(image_url)


@app.get("/staff/orders/{order_id}/id-image")
def staff_view_id_image(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
):
    return _serve_order_image(request, order_id, "id_image_url", "VIEW_ID", db)


@app.get("/staff/orders/{order_id}/luggage-image")
def staff_view_luggage_image(
    request: Request,
    order_id: str,
    db: SupabaseDB = Depends(get_db),
):
    return _serve_order_image(request, order_id, "luggage_image_url", "VIEW_LUGGAGE", db)


@app.post("/staff/admin/retention/run")
def admin_run_retention(request: Request, db: SupabaseDB = Depends(get_db)) -> RedirectResponse:
    _ = get_current_staff(request, db, require_admin=True)
    try:
        result = run_retention_cleanup(db)
        image_deleted = int(result.get("image_deleted", 0) or 0)
        order_deleted = int(result.get("order_deleted", 0) or 0)
        audit_deleted = int(result.get("audit_deleted", 0) or 0)
        if image_deleted == 0 and order_deleted == 0 and audit_deleted == 0:
            retention_msg = "보관기간 정리 완료: 삭제할 만료 데이터가 없습니다."
        else:
            retention_msg = (
                "보관기간 정리 완료: "
                f"사진 {image_deleted:,}건, "
                f"접수 {order_deleted:,}건, "
                f"열람로그 {audit_deleted:,}건 삭제"
            )
        query = urlencode({"retention_msg": retention_msg})
    except Exception:
        query = urlencode({"retention_err": "보관기간 정리 중 오류가 발생했습니다. 다시 시도해주세요."})
    return RedirectResponse(url=f"/staff/dashboard?{query}#manual-tools", status_code=status.HTTP_303_SEE_OTHER)
