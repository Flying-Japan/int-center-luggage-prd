from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import DATA_DIR, DATABASE_URL, ID_UPLOAD_DIR, LUGGAGE_UPLOAD_DIR


DATA_DIR.mkdir(parents=True, exist_ok=True)
ID_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
LUGGAGE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

engine_kwargs: dict[str, object] = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
