// backend/src/llm/schemas/retcon-author.ts
//
// MYT-73 — the retcon-author output. On a detected core-secret break, a
// dedicated Opus call writes a secret-preserving CORRECTION the narrator
// delivers OPENLY to the players ("earlier I said X — correction, it's
// actually Z"). retconText is the player-facing correction prose; it MUST
// remove the contradiction WITHOUT revealing the secret, paraphrased or
// implied.

import { z } from 'zod'

// Flat object (no root union, NO .refine — a refine lets the repair chain
// author a "valid" tree, defeating the single-gate guarantee). retconText is
// free-prose surfaced to the player verbatim, so .min(1) floor, NO .max();
// rejecting valid generated prose for length burns spent tokens and the
// repair model fixes JSON, not over-length prose. supersededContent is the
// false thing being corrected. tier is the provenance tag for the corrected
// content.
export const RetconResultSchema = z.object({
  retconText: z.string().min(1),
  supersededContent: z.string().min(1),
  tier: z.enum(['known', 'discoverable', 'secret']),
})
export type RetconResult = z.infer<typeof RetconResultSchema>
