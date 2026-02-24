import unittest
from datetime import datetime, timezone

from app.config import JST
from app.services.storage import calculate_storage_days


class StorageDayTest(unittest.TestCase):
    def test_same_day_is_one(self):
        created = datetime(2026, 2, 19, 1, 0, tzinfo=timezone.utc)
        pickup = datetime(2026, 2, 19, 9, 0, tzinfo=timezone.utc)
        self.assertEqual(calculate_storage_days(created, pickup), 1)

    def test_next_day_is_two(self):
        created = datetime(2026, 2, 19, 9, 0, tzinfo=JST).astimezone(timezone.utc)
        pickup = datetime(2026, 2, 20, 10, 0, tzinfo=JST).astimezone(timezone.utc)
        self.assertEqual(calculate_storage_days(created, pickup), 2)


if __name__ == "__main__":
    unittest.main()
