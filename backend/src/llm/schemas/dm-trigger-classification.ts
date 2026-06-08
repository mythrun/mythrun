import { z } from 'zod'

/**
 * Result of the DM Trigger Classifier (Haiku) deciding whether the AI DM
 * should respond to a player message in multiplayer chat (spec §4.4).
 *
 * - `shouldRespond`: whether the DM should produce a turn at all.
 * - `intent`: 'reactive' (responding to a direct address/action) vs
 *   'proactive' (the DM injects itself, e.g. table drifted off-topic).
 * - `complexity`: 'low' is handled by the cheap tier; 'high' escalates to
 *   the Slow Thinker.
 * - `confidence`: probability in [0, 1] used for confidence-based escalation.
 * - `reason`: free-prose justification (`.min(1)` only — no prose cap).
 */
export const DmTriggerClassificationSchema = z.object({
  shouldRespond: z.boolean(),
  intent: z.enum(['reactive', 'proactive']),
  complexity: z.enum(['low', 'high']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})

export type DmTriggerClassification = z.infer<typeof DmTriggerClassificationSchema>
