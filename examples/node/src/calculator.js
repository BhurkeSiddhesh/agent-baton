/**
 * Calculator module - realistic feature code for Node.js example project.
 */

/**
 * Add two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Operands must be finite numbers');
  }
  return a + b;
}

/**
 * Subtract b from a.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function subtract(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Operands must be finite numbers');
  }
  return a - b;
}

/**
 * Multiply two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function multiply(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Operands must be finite numbers');
  }
  return a * b;
}

/**
 * Divide a by b.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function divide(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Operands must be finite numbers');
  }
  if (b === 0) {
    throw new RangeError('Division by zero');
  }
  return a / b;
}

/**
 * Compute power: a raised to b.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function power(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('Operands must be finite numbers');
  }
  return Math.pow(a, b);
}

/**
 * Compute factorial of a non-negative integer.
 * @param {number} n
 * @returns {number}
 */
export function factorial(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new RangeError('Factorial requires a non-negative integer');
  }
  if (n === 0 || n === 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}
