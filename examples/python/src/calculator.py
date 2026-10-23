"""Calculator module - realistic feature code for Python example project."""

from typing import Union
import math

Number = Union[int, float]


def _check_number(val: Number, name: str = "Operand") -> None:
    if not isinstance(val, (int, float)) or isinstance(val, bool) or math.isnan(val) or math.isinf(val):
        raise TypeError(f"{name} must be a finite number, got {type(val).__name__}")


def add(a: Number, b: Number) -> Number:
    """Return the sum of a and b."""
    _check_number(a, "Operand 'a'")
    _check_number(b, "Operand 'b'")
    return a + b


def subtract(a: Number, b: Number) -> Number:
    """Return the difference between a and b."""
    _check_number(a, "Operand 'a'")
    _check_number(b, "Operand 'b'")
    return a - b


def multiply(a: Number, b: Number) -> Number:
    """Return the product of a and b."""
    _check_number(a, "Operand 'a'")
    _check_number(b, "Operand 'b'")
    return a * b


def divide(a: Number, b: Number) -> float:
    """Return the quotient of a divided by b. Raises ZeroDivisionError if b == 0."""
    _check_number(a, "Operand 'a'")
    _check_number(b, "Operand 'b'")
    if b == 0:
        raise ZeroDivisionError("Division by zero")
    return a / b


def power(a: Number, b: Number) -> Number:
    """Return a raised to the power of b."""
    _check_number(a, "Operand 'a'")
    _check_number(b, "Operand 'b'")
    return math.pow(a, b)


def factorial(n: int) -> int:
    """Return the factorial of a non-negative integer n."""
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError(f"Factorial requires an integer, got {type(n).__name__}")
    if n < 0:
        raise ValueError("Factorial requires a non-negative integer")
    return math.factorial(n)
