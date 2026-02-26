from collections.abc import Generator

from app.config import SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
from app.supabase_client import SupabaseDB


def get_db() -> Generator[SupabaseDB, None, None]:
    db = SupabaseDB(url=SUPABASE_URL, service_role_key=SUPABASE_SERVICE_ROLE_KEY)
    try:
        yield db
    finally:
        db.close()
