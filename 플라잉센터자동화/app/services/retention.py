from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import (
    ID_IMAGE_RETENTION_DAYS,
    LUGGAGE_IMAGE_RETENTION_DAYS,
    ORDER_RETENTION_DAYS,
)
from app.supabase_client import SupabaseDB


def _safe_unlink(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def run_retention_cleanup(db: SupabaseDB) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    image_threshold = now - timedelta(days=min(ID_IMAGE_RETENTION_DAYS, LUGGAGE_IMAGE_RETENTION_DAYS))
    order_threshold = now - timedelta(days=ORDER_RETENTION_DAYS)

    image_deleted = 0
    order_deleted = 0
    audit_deleted = 0

    image_expired_orders = db.query("orders").filter(("created_at", "<", image_threshold)).all()
    for order in image_expired_orders:
        changed = False
        if order.id_image_url:
            _safe_unlink(Path(order.id_image_url))
            image_deleted += 1
            order.id_image_url = ""
            changed = True
        if order.luggage_image_url:
            _safe_unlink(Path(order.luggage_image_url))
            image_deleted += 1
            order.luggage_image_url = ""
            changed = True
        if changed:
            db.update(order)

    old_orders = db.query("orders").filter(("created_at", "<", order_threshold)).all()
    for order in old_orders:
        _safe_unlink(Path(order.id_image_url or ""))
        _safe_unlink(Path(order.luggage_image_url or ""))

        audit_deleted += db.delete_where(
            "audit_logs", [("order_id", "=", order.order_id)]
        )
        db.delete_row("orders", "order_id", order.order_id)
        order_deleted += 1

    return {
        "image_deleted": image_deleted,
        "order_deleted": order_deleted,
        "audit_deleted": audit_deleted,
    }
