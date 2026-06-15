// backend/src/llm/schemas/st-lookup-vet.ts
//
// MYT-72 §17.4 — the ST-vet output for a world-knowledge lookup. The ST-vet is
// the SINGLE tier-safety gate: it sees over-pulled, tier-annotated results +
// the secret sd_playbook, then emits the player-facing answer.

import { z } from 'zod'

// Flat object (no root union). mode is the trichotomy; text is the player-
// facing relay/invention prose (verbatim to the player — authoritative like
// st-director's `direction`, so .min(1) floor, NO .max()); tier is the ST's
// provenance tag for the relayed/invented content (emitted now, consumed by
// MYT-73's Scribe). NO .refine — a refine lets the repair chain author a
// "valid" tree, which defeats the single-gate guarantee.
export const StLookupVetResultSchema = z.object({
  mode: z.enum(['relay', 'none', 'invent']),
  text: z.string().min(1),
  tier: z.enum(['known', 'discoverable', 'secret']),
})
export type StLookupVetResult = z.infer<typeof StLookupVetResultSchema>
