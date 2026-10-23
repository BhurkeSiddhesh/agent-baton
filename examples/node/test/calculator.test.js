import test from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract, multiply, divide, power, factorial } from '../src/calculator.js';

test('add combines numbers correctly', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
  assert.equal(add(0, 0), 0);
});

test('subtract computes difference correctly', () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(0, 7), -7);
});

test('multiply calculates product correctly', () => {
  assert.equal(multiply(3, 4), 12);
  assert.equal(multiply(-2, 5), -10);
  assert.equal(multiply(0, 100), 0);
});

test('divide computes quotient and rejects division by zero', () => {
  assert.equal(divide(10, 2), 5);
  assert.equal(divide(7, 2), 3.5);
  assert.throws(() => divide(10, 0), {
    name: 'RangeError',
    message: /Division by zero/,
  });
});

test('power computes exponential correctly', () => {
  assert.equal(power(2, 3), 8);
  assert.equal(power(5, 0), 1);
  assert.equal(power(9, 0.5), 3);
});

test('factorial calculates correctly and validates input', () => {
  assert.equal(factorial(0), 1);
  assert.equal(factorial(1), 1);
  assert.equal(factorial(5), 120);
  assert.throws(() => factorial(-1), {
    name: 'RangeError',
    message: /non-negative integer/,
  });
  assert.throws(() => factorial(3.14), {
    name: 'RangeError',
    message: /non-negative integer/,
  });
});

test('input validation rejects non-numbers', () => {
  assert.throws(() => add('2', 3), { name: 'TypeError' });
  assert.throws(() => subtract(2, null), { name: 'TypeError' });
  assert.throws(() => multiply(NaN, 5), { name: 'TypeError' });
  assert.throws(() => divide(Infinity, 2), { name: 'TypeError' });
  assert.throws(() => power(2, undefined), { name: 'TypeError' });
});
