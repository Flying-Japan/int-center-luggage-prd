import argparse

from app.auth import hash_pin
from app.database import SessionLocal
from app.models import Staff


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or update a staff account.")
    parser.add_argument("--name", required=True, help="Staff login name")
    parser.add_argument("--pin", required=True, help="PIN (4+ digits recommended)")
    parser.add_argument("--admin", action="store_true", help="Grant admin role")
    parser.add_argument(
        "--update-existing",
        action="store_true",
        help="Update existing account when same name already exists",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    name = args.name.strip()
    pin = args.pin.strip()
    if not name:
        raise SystemExit("Name is required.")
    if len(pin) < 4:
        raise SystemExit("PIN must be at least 4 characters.")

    db = SessionLocal()
    try:
        row = db.query(Staff).filter(Staff.name == name).first()
        if row is None:
            row = Staff(
                name=name,
                pin_hash=hash_pin(pin),
                is_admin=bool(args.admin),
                is_active=True,
            )
            db.add(row)
            db.commit()
            print(f"[CREATED] name={name} admin={row.is_admin}")
            return

        if not args.update_existing:
            raise SystemExit("Account already exists. Use --update-existing to modify it.")

        row.pin_hash = hash_pin(pin)
        row.is_admin = bool(args.admin)
        row.is_active = True
        db.commit()
        print(f"[UPDATED] name={name} admin={row.is_admin}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
