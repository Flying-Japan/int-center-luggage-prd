from app.database import SessionLocal
from app.services.retention import run_retention_cleanup


def main() -> None:
    db = SessionLocal()
    try:
        result = run_retention_cleanup(db)
        print(result)
    finally:
        db.close()


if __name__ == "__main__":
    main()
