"""App settings: read/write helpers for the app_settings table."""
from __future__ import annotations

from app.supabase_client import SupabaseDB


def get_app_setting(db: SupabaseDB, setting_key: str, default_value: str) -> str:
    row = db.query("app_settings").filter(("setting_key", "=", setting_key)).first()
    if row is None:
        return default_value
    return row.setting_value or default_value


def upsert_app_setting(db: SupabaseDB, setting_key: str, setting_value: str, staff_id: str):
    row = db.query("app_settings").filter(("setting_key", "=", setting_key)).first()
    normalized_value = setting_value.strip()
    if row is None:
        return db.insert("app_settings", {
            "setting_key": setting_key,
            "setting_value": normalized_value,
            "staff_id": staff_id,
        })
    else:
        row.setting_value = normalized_value
        row.staff_id = staff_id
        db.update(row)
        return row
