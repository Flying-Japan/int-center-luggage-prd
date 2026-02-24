from typing import Optional

from fastapi import HTTPException, Request, status

from app.supabase_client import SupabaseDB


def get_current_staff(request: Request, db: SupabaseDB, *, require_admin: bool = False):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/staff/login"})

    staff = db.get("user_profiles", "id", user_id)
    if not staff or not staff.is_active:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/staff/login"})

    if require_admin and staff.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")

    return staff
