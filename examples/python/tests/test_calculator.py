"""Unit tests for Python calculator module."""

import os
import sys
import unittest

# Ensure src directory is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from calculator import add, subtract, multiply, divide, power, factorial


class TestCalculator(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
        self.assertEqual(add(-1, 1), 0)
        self.assertEqual(add(0, 0), 0)

    def test_subtract(self):
        self.assertEqual(subtract(5, 3), 2)
        self.assertEqual(subtract(0, 7), -7)

    def test_multiply(self):
        self.assertEqual(multiply(3, 4), 12)
        self.assertEqual(multiply(-2, 5), -10)
        self.assertEqual(multiply(0, 100), 0)

    def test_divide(self):
        self.assertEqual(divide(10, 2), 5.0)
        self.assertEqual(divide(7, 2), 3.5)
        with self.assertRaises(ZeroDivisionError):
            divide(10, 0)

    def test_power(self):
        self.assertEqual(power(2, 3), 8.0)
        self.assertEqual(power(5, 0), 1.0)
        self.assertEqual(power(9, 0.5), 3.0)

    def test_factorial(self):
        self.assertEqual(factorial(0), 1)
        self.assertEqual(factorial(1), 1)
        self.assertEqual(factorial(5), 120)
        with self.assertRaises(ValueError):
            factorial(-1)

    def test_type_validation(self):
        with self.assertRaises(TypeError):
            add("2", 3)
        with self.assertRaises(TypeError):
            subtract(2, None)
        with self.assertRaises(TypeError):
            multiply(float("nan"), 5)
        with self.assertRaises(TypeError):
            divide(float("inf"), 2)
        with self.assertRaises(TypeError):
            factorial(3.14)
        with self.assertRaises(TypeError):
            add(True, 1)


if __name__ == "__main__":
    unittest.main()
