from collections.abc import Generator

from app.config import ID_UPLOAD_DIR, LUGGAGE_UPLOAD_DIR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
from app.supabase_client import SupabaseDB


ID_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
LUGGAGE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def get_db() -> Generator[SupabaseDB, None, None]:
    db = SupabaseDB(url=SUPABASE_URL, service_role_key=SUPABASE_SERVICE_ROLE_KEY)
    try:
        yield db
    finally:
        db.close()
