// backend/src/repo/characters-errors.ts
//
// Custom Error subclasses thrown by repo.characters.

export class CharacterAlreadyInCampaignError extends Error {
  readonly code = 'CHARACTER_ALREADY_IN_CAMPAIGN'
  constructor(
    readonly campaignId: string,
    readonly characterId: string,
  ) {
    super(`Character ${characterId} is already in campaign ${campaignId}`)
    this.name = 'CharacterAlreadyInCampaignError'
  }
}

export class UserAlreadyHasCharacterInCampaignError extends Error {
  readonly code = 'USER_ALREADY_HAS_CHARACTER_IN_CAMPAIGN'
  constructor(
    readonly campaignId: string,
    readonly userId: string,
  ) {
    super(`User ${userId} already has a character in campaign ${campaignId}`)
    this.name = 'UserAlreadyHasCharacterInCampaignError'
  }
}
