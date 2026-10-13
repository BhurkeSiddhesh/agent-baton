/** Rule violation or failed check. The CLI prints it and exits 1. */
export class BatonError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, hint?: string|null, details?: any}} [opts]
   */
  constructor(message, { code = 'BATON_ERROR', hint = null, details = null } = {}) {
    super(message);
    this.name = 'BatonError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

/** Bad command line (unknown option, missing value, ...). The CLI exits 2. */
export class UsageError extends BatonError {
  constructor(message, opts = {}) {
    super(message, { code: 'USAGE', ...opts });
    this.name = 'UsageError';
  }
}

/** Exit code for a thrown value: UsageError 2, BatonError 1, anything else 3. */
export function exitCodeFor(err) {
  if (err instanceof UsageError) return 2;
  if (err instanceof BatonError) return 1;
  return 3;
}
