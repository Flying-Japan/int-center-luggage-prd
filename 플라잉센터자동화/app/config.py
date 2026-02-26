from pathlib import Path
import os
from zoneinfo import ZoneInfo


BASE_DIR = Path(__file__).resolve().parent.parent
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV in {"prod", "production"}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
APP_BASE_URL = os.getenv("APP_BASE_URL", "").rstrip("/")

SECRET_KEY = os.getenv("APP_SECRET_KEY", "dev-secret-change-me")
SESSION_HTTPS_ONLY = _env_bool("SESSION_HTTPS_ONLY", IS_PRODUCTION)
SESSION_SAME_SITE = os.getenv("SESSION_SAME_SITE", "lax").strip().lower() or "lax"
SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE", str(60 * 60 * 12)))
AUTO_SEED_DEFAULT_STAFF = _env_bool("AUTO_SEED_DEFAULT_STAFF", not IS_PRODUCTION)

JST = ZoneInfo("Asia/Tokyo")

BUSINESS_OPEN_HOUR = 9
BUSINESS_CLOSE_HOUR = 21

ID_IMAGE_RETENTION_DAYS = 14
LUGGAGE_IMAGE_RETENTION_DAYS = 14
ORDER_RETENTION_DAYS = 60

MAX_BAG_QTY = 99
MAX_COMPANION_COUNT = 99

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_API_TOKEN = os.getenv("R2_API_TOKEN", os.getenv("CLOUDFLARE_API_TOKEN", ""))
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "luggage-images")
