from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import (
    ID_IMAGE_RETENTION_DAYS,
    LUGGAGE_IMAGE_RETENTION_DAYS,
    ORDER_RETENTION_DAYS,
)
from app.models import AuditLog, Order


def _safe_unlink(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        # Keep cleanup idempotent even if file system has transient issues.
        pass


def run_retention_cleanup(db: Session) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    image_threshold = now - timedelta(days=min(ID_IMAGE_RETENTION_DAYS, LUGGAGE_IMAGE_RETENTION_DAYS))
    order_threshold = now - timedelta(days=ORDER_RETENTION_DAYS)

    image_deleted = 0
    order_deleted = 0
    audit_deleted = 0

    image_expired_orders = db.query(Order).filter(Order.created_at < image_threshold).all()
    for order in image_expired_orders:
        if order.id_image_url:
            _safe_unlink(Path(order.id_image_url))
            image_deleted += 1
            order.id_image_url = ""
        if order.luggage_image_url:
            _safe_unlink(Path(order.luggage_image_url))
            image_deleted += 1
            order.luggage_image_url = ""

    old_orders = db.query(Order).filter(Order.created_at < order_threshold).all()
    for order in old_orders:
        _safe_unlink(Path(order.id_image_url))
        _safe_unlink(Path(order.luggage_image_url))

        audit_deleted += (
            db.query(AuditLog).filter(AuditLog.order_id == order.order_id).delete(synchronize_session=False)
        )
        db.delete(order)
        order_deleted += 1

    db.commit()
    return {
        "image_deleted": image_deleted,
        "order_deleted": order_deleted,
        "audit_deleted": audit_deleted,
    }
