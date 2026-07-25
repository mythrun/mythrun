import type { RailStep } from './types.ts'

// GuidedRail (MYT-102) — the guided builder's progress rail as a standalone
// component: the same done/now/todo rung row GuidedBuilder shows on its option
// steps, renderable on the builder-less screens of the same journey (the notes
// and grounding prompts), so the signposting never disappears mid-flow.
// Platform-neutral (§9): pure data in, no callbacks (the rail is a status
// display, never interactive), no className/style.

/** Props for the guided-journey progress rail. */
export interface GuidedRailProps {
  /** The rungs to show, in journey order (one per step, each done/now/todo). */
  rail: RailStep[]
  /** Optional resolved step counter (e.g. "Step 2 of 5"), rendered as a quiet
   *  trailing line on the rail row — the "how far" the rung row alone does not
   *  carry (ux-run2 myth-udhp3). */
  counter?: string
  /** Optional test hook for the root list (defaults to `guided-rail`). */
  'data-testid'?: string
}
