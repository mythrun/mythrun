// backend/src/repo/session-participants-errors.ts
//
// Typed errors thrown by the session-participants repo. Mirrors the
// characters-errors.ts / sessions-errors.ts pattern so callers can use
// instanceof narrowing.

export class NoCharacterForParticipantError extends Error {
  readonly code = 'NO_CHARACTER_FOR_PARTICIPANT' as const
  constructor(
    readonly campaignId: string,
    readonly userId: string,
  ) {
    super(`NoCharacterForParticipantError: user ${userId} has no character in campaign ${campaignId}`)
    this.name = 'NoCharacterForParticipantError'
  }
}
