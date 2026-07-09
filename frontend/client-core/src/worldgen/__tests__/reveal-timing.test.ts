import { describe, expect, it } from 'vitest'
import { TAIL_STAGES, type StageProgress } from '@mythrun/contract/events'
import { completedTailStageCount, connectionsDone } from '../reveal-timing.ts'

// The wiki-reveal timing brain (MYT-89 reveal timing): two pure predicates over
// the stream's folded `stages[]`.
//
//   - `connectionsDone` — TRUE the moment the reveal-boundary stage
//     (entity_relationships, connection-weaving) has COMPLETED. This is the
//     campaign-detail route's generating → reveal transition signal: not before
//     (a RUNNING entity_relationships is still the visible wait) and not after
//     (embed_world completing is NOT required — the tail is nobody's wait).
//   - `completedTailStageCount` — how many silent TAIL stages have completed;
//     the reveal's quiet wiki-refetch token (each completion bumps it, each bump
//     refetches the snapshot so reconciled facts appear without a spinner).

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

describe('connectionsDone — the generating → reveal transition signal', () => {
  it('is FALSE before the boundary stage appears (empty / prep-only stream)', () => {
    expect(connectionsDone([])).toBe(false)
    expect(connectionsDone([stage('concept_intake', 'completed')])).toBe(false)
  })

  it('is FALSE while world_introduction is still RUNNING (no early transition)', () => {
    // myth-zaqxh: the boundary is the intro page. Connections are already drawn
    // (entity_relationships completed), but the reveal waits for the intro.
    expect(
      connectionsDone([
        stage('entity_relationships', 'completed'),
        stage('world_introduction', 'running'),
      ]),
    ).toBe(false)
  })

  it('is TRUE the moment world_introduction COMPLETES — the tail is NOT required', () => {
    // The tail (consolidation → embed) has not even started: the reveal fires anyway.
    expect(
      connectionsDone([
        stage('world_and_factions', 'completed'),
        stage('locations_and_npcs', 'completed'),
        stage('entity_relationships', 'completed'),
        stage('world_introduction', 'completed'),
      ]),
    ).toBe(true)
  })

  it('stays TRUE while the silent tail runs and after it finishes', () => {
    const base = [stage('world_introduction', 'completed')]
    expect(connectionsDone([...base, stage('entity_consolidation', 'running')])).toBe(true)
    expect(connectionsDone([...base, stage('embed_world', 'completed')])).toBe(true)
  })

  it('a FAILED world_introduction does not transition', () => {
    expect(connectionsDone([stage('world_introduction', 'failed')])).toBe(false)
  })
})

describe('completedTailStageCount — the quiet wiki-refetch token', () => {
  it('is 0 before any tail stage completes (running tail stages do not count)', () => {
    expect(completedTailStageCount([])).toBe(0)
    expect(
      completedTailStageCount([
        stage('entity_relationships', 'completed'),
        stage('entity_consolidation', 'running'),
      ]),
    ).toBe(0)
  })

  it('counts each COMPLETED tail stage — the token bumps once per silent completion', () => {
    expect(
      completedTailStageCount([
        stage('entity_relationships', 'completed'), // watched — not a tail stage
        stage('entity_consolidation', 'completed'),
        stage('starting_situation', 'completed'),
        stage('coherence_pass', 'running'),
      ]),
    ).toBe(2)
  })

  it('reaches the full tail length when generation finishes', () => {
    const all = TAIL_STAGES.map((s) => stage(s, 'completed'))
    expect(completedTailStageCount(all)).toBe(TAIL_STAGES.length)
  })

  it('ignores non-worldgen stages (per-player charcreation rows share the stream)', () => {
    expect(completedTailStageCount([stage('character_sheet', 'completed')])).toBe(0)
  })
})
