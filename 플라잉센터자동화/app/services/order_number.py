from datetime import datetime

from app.config import JST
from app.supabase_client import SupabaseDB


def build_order_id(db: SupabaseDB, now_utc: datetime) -> str:
    business_date = now_utc.astimezone(JST).strftime("%Y%m%d")
    counter = db.get("daily_counters", "business_date", business_date)

    if counter is None:
        db.insert("daily_counters", {"business_date": business_date, "last_seq": 1})
        seq = 1
    else:
        counter.last_seq += 1
        db.update(counter)
        seq = counter.last_seq

    return f"{business_date}-{seq:03d}"


def build_tag_no(db: SupabaseDB, now_utc: datetime) -> str:
    business_date = now_utc.astimezone(JST).strftime("%Y%m%d")
    counter = db.get("daily_tag_counters", "business_date", business_date)

    if counter is None:
        db.insert("daily_tag_counters", {"business_date": business_date, "last_seq": 1})
        seq = 1
    else:
        counter.last_seq += 1
        db.update(counter)
        seq = counter.last_seq

    return str(seq)
