from datetime import datetime

from sqlalchemy.orm import Session

from app.config import JST
from app.models import DailyCounter, DailyTagCounter


def build_order_id(db: Session, now_utc: datetime) -> str:
    business_date = now_utc.astimezone(JST).strftime("%Y%m%d")
    counter = db.get(DailyCounter, business_date)

    if counter is None:
        counter = DailyCounter(business_date=business_date, last_seq=1)
        db.add(counter)
    else:
        counter.last_seq += 1

    db.flush()
    return f"{business_date}-{counter.last_seq:03d}"


def build_tag_no(db: Session, now_utc: datetime) -> str:
    business_date = now_utc.astimezone(JST).strftime("%Y%m%d")
    counter = db.get(DailyTagCounter, business_date)

    if counter is None:
        counter = DailyTagCounter(business_date=business_date, last_seq=1)
        db.add(counter)
    else:
        counter.last_seq += 1

    db.flush()
    return str(counter.last_seq)
