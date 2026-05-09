// backend/src/repo/sessions-errors.ts
//
// Typed errors thrown by the sessions repo. Mirrors the credits-errors.ts
// pattern (UserNotFoundError / InsufficientCreditsError / etc.) so callers
// can use instanceof narrowing.

export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found' as const
  constructor(public readonly sessionId: string) {
    super(`SessionNotFoundError: no session with id ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}
