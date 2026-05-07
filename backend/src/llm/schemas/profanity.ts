import { z } from 'zod'

/**
 * Result of classifying a username for offensive content or impersonation.
 *
 * `reason` is omitted when `profane` is false. When `profane` is true, the
 * model returns one of two categories:
 *   - 'offensive': profanity, slurs, sexual content, hate speech, violence
 *   - 'impersonation': system role, Mythrun brand/staff, technical identifier
 *
 * If both categories apply, the prompt instructs the model to prefer
 * 'offensive' (the stronger reason for rejection).
 */
export const ProfanitySchema = z.object({
  profane: z.boolean(),
  reason: z.enum(['offensive', 'impersonation']).optional(),
})

export type ProfanityResult = z.infer<typeof ProfanitySchema>
