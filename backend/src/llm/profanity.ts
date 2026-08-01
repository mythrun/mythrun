import { generateObject } from './ai.js'
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
 *
 * Routes through the canonical `generateObject` wrapper (myth-t1qz):
 * schema-repair fallback + structured diagnostic logging on failure.
 */
export async function classifyProfanity(
  text: string,
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. OPTIONAL: the classifier's current callers are all
   *  auth/user routes; a non-session line without sessionId is correct
   *  behavior. Session-context callers thread it. */
  opts?: { readonly sessionId?: string },
): Promise<ProfanityResult> {
  const result = await generateObject({
    model: HAIKU,
    schema: ProfanitySchema,
    system: loadPrompt('auth', 'profanity'),
    prompt: text,
    maxRetries: 3,
    callSite: 'username-profanity-classifier',
    providerOptions: { mythrun: { stage: 'profanity_gate', sessionId: opts?.sessionId } },
    schemaName: 'ProfanitySchema',
  })
  return result.output
}
