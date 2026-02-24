import unittest

from app.services.pricing import calculate_prepaid_amount, calculate_price_per_day, discount_rate_for_days


class PricingTest(unittest.TestCase):
    def test_set_matching(self):
        result = calculate_price_per_day(2, 3)
        self.assertEqual(result.set_qty, 2)
        self.assertEqual(result.price_per_day, 2900)

    def test_discount_tiers(self):
        self.assertEqual(discount_rate_for_days(6), 0.0)
        self.assertEqual(discount_rate_for_days(7), 0.05)
        self.assertEqual(discount_rate_for_days(14), 0.10)
        self.assertEqual(discount_rate_for_days(30), 0.15)
        self.assertEqual(discount_rate_for_days(60), 0.20)

    def test_prepaid_amount(self):
        discount, prepaid = calculate_prepaid_amount(1200, 10)
        self.assertEqual(discount, 0.05)
        self.assertEqual(prepaid, 11400)


if __name__ == "__main__":
    unittest.main()
