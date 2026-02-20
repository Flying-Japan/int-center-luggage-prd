import hashlib
from typing import Optional

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.models import Staff


def hash_pin(pin: str) -> str:
    return hashlib.sha256(pin.encode("utf-8")).hexdigest()


def verify_pin(pin: str, pin_hash: str) -> bool:
    return hash_pin(pin) == pin_hash


def get_current_staff(request: Request, db: Session, *, require_admin: bool = False) -> Staff:
    staff_id = request.session.get("staff_id")
    if not staff_id:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/staff/login"})

    staff = db.get(Staff, staff_id)
    if not staff or not staff.is_active:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/staff/login"})

    if require_admin and not staff.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")

    return staff
