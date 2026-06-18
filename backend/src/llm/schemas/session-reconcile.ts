// backend/src/llm/schemas/session-reconcile.ts
//
// MYT-74a — end-of-session reconciliation plan. The structured output of the
// reconciler (an Opus call) that folds a session's working set into canon. It
// expresses a PLAN of canon-write operations:
//   - entity ops: `match` (bind a working-set subject to an existing canon
//     entity by id) or `mint` (create a new canon entity);
//   - fact ops: append a fact under a subject's topic, optionally superseding an
//     existing canon fact by id; `claimedBy` is the structural attribution
//     signal (an NPC name for an attributed claim, else null);
//   - relationship ops: directed edges between two working-set subjects.
//
// `subjectName` fields reference working-set items by their stamped name (the
// tier-floor join key carried through from the session). `canonEntityId` /
// `supersedesFactId` reference existing canon rows by id, nullable.
//
// Flat `z.object` root, NO `.refine` (a refine lets the repair chain author a
// "valid" tree), `.min(1)` floors on required free-prose fields, and NO `.max()`
// on free-prose fields (rejecting valid generated prose for length wastes spent
// tokens + terminal-fails the stage).

import { z } from 'zod'

export const ReconcilePlanSchema = z.object({
  entities: z.array(
    z.object({
      op: z.enum(['match', 'mint']),
      subjectName: z.string().min(1),
      canonEntityId: z.string().nullable(), // set when op='match'
      name: z.string().min(1), // canonical name
      entityType: z.enum(['npc', 'location', 'faction', 'item']),
      accessLevel: z.enum(['known', 'discoverable', 'secret']),
    }),
  ),
  facts: z.array(
    z.object({
      subjectName: z.string().min(1), // the carried-through working-set key (tier-floor join)
      topic: z.string().min(1), // facts.topic is NOT NULL; model-emitted
      content: z.string().min(1), // attribution baked in for attributed items; NO .max()
      accessLevel: z.enum(['known', 'discoverable', 'secret']),
      claimedBy: z.string().nullable(), // NPC name for an attributed claim, else null
      supersedesFactId: z.string().nullable(),
    }),
  ),
  relationships: z.array(
    z.object({
      fromSubjectName: z.string().min(1),
      toSubjectName: z.string().min(1),
      relationshipType: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  /** MYT-74c — ids of EXISTING candidate facts (discoverable/secret) the
   *  reconciler MATCHED to a working-set item this session and judged should
   *  become public → promote to `known`. Each must be a live candidate factId
   *  (validator-enforced). `.default([])` so an absent field / EMPTY_PLAN is [],
   *  never a terminal repair failure. NEVER a fact also being superseded. */
  promotions: z.array(z.string()).default([]),
})
export type ReconcilePlan = z.infer<typeof ReconcilePlanSchema>
