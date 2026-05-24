// backend/src/llm/prep/__tests__/character-creation-stages-list.test.ts
//
// MYT-54 T3: pins the per-player character-creation pipeline shape to
// the three stages that remain after the integration step was lifted to
// a campaign-scoped Opus pass (owned by MYT-54's character-integration-
// processor, wired up in T11). Pins the contract so future edits don't
// silently re-introduce the per-player integration stage.
//
// Note: T3's prompt suggested a 2-element expectation (['character_concept',
// 'character_sheet']), but the live processor also runs 'location_selection'
// before 'character_concept'. T4 (myth-d0q1) confirms 'location_selection'
// stays in CHARCREATION_STAGES — only 'character_integration' lifts to the
// campaign-scoped post-creation phase. The 3-element expectation below
// matches the actual code change in T3.

import { describe, it, expect } from 'vitest'
import { STAGES_IN_ORDER } from '../character-creation-processor.js'

describe('MYT-53 per-player stage list (post-MYT-54)', () => {
  it("ends at 'character_sheet' (character_integration is now campaign-scoped via MYT-54)", () => {
    expect(STAGES_IN_ORDER).toEqual([
      'location_selection',
      'character_concept',
      'character_sheet',
    ])
  })
})
