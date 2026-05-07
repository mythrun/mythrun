import { generateObject } from 'ai'
import { HAIKU } from './models.js'
import { ProfanitySchema, type ProfanityResult } from './schemas/profanity.js'
import { loadPrompt } from './prompts.js'

/**
 * Classify a username for offensive content or impersonation.
 *
 * Single Haiku call covering both rejection categories. The system prompt
 * (loaded from `prompts/auth/profanity.txt`) instructs the model to set
 * reason='offensive' for profanity/slurs/sexual content/hate speech, or
 * reason='impersonation' for system roles, Mythrun brand/staff, or
 * technical identifiers. If both apply, the prompt prefers 'offensive'.
 *
 * Returns the model's structured object verbatim. Errors propagate as
 * Mythrun-typed LLM errors (the middleware layer in models.ts maps them
 * from Vercel's APICallError / TooManyRequestsError /
 * AI_NoObjectGeneratedError before they leave the SDK call frame).
 */
export async function classifyProfanity(text: string): Promise<ProfanityResult> {
  const result = await generateObject({
    model: HAIKU,
    schema: ProfanitySchema,
    system: loadPrompt('auth', 'profanity'),
    prompt: text,
    maxRetries: 3,
  })
  return result.object
}
