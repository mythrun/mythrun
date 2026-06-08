// backend/src/llm/dm-trigger-classifier.ts
//
// MYT-67 T8 (spec §4.4, §9): the real Haiku DM-trigger classifier. One cheap
// Haiku generateObject call through the canonical ai.ts wrapper decides
// whether the AI DM should take a turn for the latest batch of player chat.
//
// Enforced ignorance by construction: DmTriggerContext carries ONLY public
// table conversation + pacing. No field can hold a secret, a plot fact, or a
// hidden NPC motive — serializeContext renders exactly those public fields and
// nothing else, so there is no path for off-screen information to reach this
// call. (Cf. the Fast Thinker boundary in CLAUDE.md non-negotiable #1.)
//
// Repair: 'haiku-then-sonnet' — cheap-first, escalating to Sonnet only when
// Haiku can't fix a malformed tree. This is a high-volume classification call;
// retrying the repair on the cheap tier first keeps cost down.
//
// Failure posture: this function does NOT swallow errors. A terminal LLM
// failure (after the wrapper's repair attempts) propagates as a Mythrun-typed
// error. Fail-closed semantics — deciding what to do when the classifier is
// unavailable — are the CALLER's job (spec §9), not this orchestration shell's.

import { generateObject } from './ai.js'
import { HAIKU } from './models.js'
import { loadPrompt } from './prompts.js'
import {
  DmTriggerClassificationSchema,
  type DmTriggerClassification,
} from './schemas/dm-trigger-classification.js'
import { HAIKU_CLASSIFY_TIMEOUT_MS } from '../session/dm-trigger-config.js'

/**
 * Public-by-construction input to the DM-trigger classifier (spec §4.4). Every
 * field here is table-visible: the attributed player-message batch, the DM's
 * last player-facing line, two pacing counters, and an optional one-line scene
 * description. No field may carry a secret — that is the enforced-ignorance
 * guarantee for this tier.
 */
export interface DmTriggerContext {
  /** The latest batch of player messages, attributed to speaking characters. */
  readonly messages: ReadonlyArray<{ readonly characterName: string; readonly text: string }>
  /** The DM's most recent player-facing output, or null if the DM hasn't spoken yet. */
  readonly lastDmOutput: string | null
  /** How many player turns have passed since the DM's last beat. */
  readonly turnsSinceLastDmBeat: number
  /** Wall-clock seconds since the DM's last beat (pacing / dead-air signal). */
  readonly secondsSinceLastDmBeat: number
  /** Optional one-line grounding of the current scene, or null. */
  readonly sceneGrounding: string | null
}

/**
 * Deterministic plain-text rendering of the public context for the Haiku
 * prompt. Only public fields are included. The layout mirrors what the system
 * prompt describes it will see: attributed message lines, the DM's last line
 * (or a no-prior-turn marker), a pacing line, and the scene grounding when
 * present.
 */
function serializeContext(ctx: DmTriggerContext): string {
  const messageLines = ctx.messages
    .map((m) => `${m.characterName}: ${m.text}`)
    .join('\n')

  const lastDmLine =
    ctx.lastDmOutput === null
      ? 'Last DM beat: (no prior DM turn this scene)'
      : `Last DM beat: ${ctx.lastDmOutput}`

  const pacingLine = `Pacing: ${ctx.secondsSinceLastDmBeat}s and ${ctx.turnsSinceLastDmBeat} message(s) since the DM last spoke`

  const sections = [
    'Recent player messages:',
    messageLines,
    '',
    lastDmLine,
    pacingLine,
  ]

  if (ctx.sceneGrounding !== null) {
    sections.push(`Scene: ${ctx.sceneGrounding}`)
  }

  return sections.join('\n')
}

/**
 * Classify whether the AI DM should take a turn for the current batch of
 * player chat (spec §4.4).
 *
 * Empty batch is a deterministic short-circuit: there is nothing to react to,
 * so we return a "no turn" verdict without spending an LLM call. Otherwise a
 * single Haiku call returns the structured classification verbatim. Errors
 * propagate (fail-closed is the caller's responsibility).
 */
export async function classifyDmTrigger(
  ctx: DmTriggerContext,
): Promise<DmTriggerClassification> {
  if (ctx.messages.length === 0) {
    return {
      shouldRespond: false,
      intent: 'reactive',
      complexity: 'low',
      confidence: 1,
      reason: 'empty batch',
    }
  }

  const result = await generateObject({
    model: HAIKU,
    schema: DmTriggerClassificationSchema,
    schemaName: 'DmTriggerClassificationSchema',
    system: loadPrompt('session', 'dm-trigger-classifier'),
    prompt: serializeContext(ctx),
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: HAIKU_CLASSIFY_TIMEOUT_MS,
    callSite: 'dm-trigger-classifier',
  })

  return result.output
}
