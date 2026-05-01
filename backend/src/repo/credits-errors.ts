// backend/src/repo/credits-errors.ts
//
// Custom Error subclasses thrown by repo.credits. Split from credits.ts so
// callers (HTTP layer, future tickets) can import these for type narrowing
// without pulling in the repo factory.

import type { CreditType } from './types.js'

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS'
  constructor(
    readonly userId: string,
    readonly creditType: CreditType,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Insufficient ${creditType} credits: have ${available}, need ${requested}`,
    )
    this.name = 'InsufficientCreditsError'
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT'
  constructor(
    readonly userId: string,
    readonly sourceId: string,
    readonly existingAmount: number,    // absolute value
    readonly requestedAmount: number,
  ) {
    super(
      `Debit with sourceId=${sourceId} already exists for amount ${existingAmount}, ` +
        `but caller requested amount ${requestedAmount}. Same idempotency key cannot ` +
        `be reused for different debits.`,
    )
    this.name = 'IdempotencyConflictError'
  }
}

export class DebitTimeoutError extends Error {
  readonly code = 'DEBIT_TIMEOUT'
  constructor(
    readonly userId: string,
    readonly sqlstate: '55P03' | '57014',
  ) {
    super(`Debit timed out for user=${userId} (sqlstate=${sqlstate})`)
    this.name = 'DebitTimeoutError'
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND'
  constructor(readonly userId: string) {
    super(`User not found: ${userId}`)
    this.name = 'UserNotFoundError'
  }
}

// ─── Constants (overridable via createCreditsRepo opts for tests) ───────────

export const DEFAULT_LIST_LIMIT = 100
export const DEBIT_LOCK_TIMEOUT_MS = 1000
export const DEBIT_STATEMENT_TIMEOUT_MS = 5000
