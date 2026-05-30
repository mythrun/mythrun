// Integration + type-level tests for repo.worlds.getSnapshotSummary — the
// named, single-sourced home of the enforced-ignorance allowlist projection
// (data-layer-repo-unification foundation gate, task B).
//
// getSnapshotSummary returns WorldSummary, a type that structurally omits the
// plot-bearing world columns (key_tensions, political_summary, world_overview,
// geography_summary, starting_situations, follow_up_questions). The boundary is
// enforced by the type system: re-pointing a Fast-Thinker read at getById
// (full row) is a compile error, not a silent leak. This file pins both the
// runtime shape (plot keys absent) and the type-level shape (plot keys are not
// assignable onto WorldSummary).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo } from '../index.js'
import type { WorldSummary } from '../world-snapshot-view.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// Type-level assertion: WorldSummary must NOT carry any plot-bearing column.
// If a future edit widens WorldSummary to include one of these keys, this
// block fails to compile (the key would be assignable, so `Extract` is
// non-`never`). `@ts-expect-error` would be the wrong tool — these keys
// genuinely don't exist on the type; we assert that via keyof.
type PlotKeys =
  | 'key_tensions'
  | 'keyTensions'
  | 'political_summary'
  | 'politicalSummary'
  | 'world_overview'
  | 'worldOverview'
  | 'geography_summary'
  | 'geographySummary'
  | 'starting_situations'
  | 'startingSituations'
  | 'follow_up_questions'
  | 'followUpQuestions'
// Resolves to `never` iff no plot key is a member of keyof WorldSummary.
type LeakedPlotKeys = Extract<keyof WorldSummary, PlotKeys>
// Compile-time guard: assigning `never` to this const fails if LeakedPlotKeys
// ever widens past `never`.
const _noPlotKeysOnSummary: LeakedPlotKeys extends never ? true : never = true
void _noPlotKeysOnSummary

describe('repo.worlds.getSnapshotSummary — enforced-ignorance allowlist', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('snapshot-summary')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  async function seedWorldWithPlot(): Promise<{ worldId: string }> {
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    const worldId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                            dev_bypass_access_filter, era, key_tensions,
                            political_summary, world_overview, geography_summary,
                            starting_situations, follow_up_questions)
       VALUES ($1, $2, $3, 'a concept', 'wistful', 'belonging', 'generating', false,
               'the late bronze age', 'the king is dying', 'a fractured court',
               'a sweeping overview of secrets', 'a hidden delta',
               'an unrevealed opening scene', 'what does the player fear?')`,
      [worldId, userId, scope.worldName(0)],
    )
    return { worldId }
  }

  it('returns the allowlist shape and never the plot columns', async () => {
    const repo = createRepo(pool)
    const { worldId } = await seedWorldWithPlot()

    const summary = await repo.worlds.getSnapshotSummary(worldId)
    expect(summary).not.toBeNull()
    if (summary === null) throw new Error('unreachable')

    // Exactly the allowlist keys — no more.
    expect(Object.keys(summary).sort()).toEqual(
      ['concept', 'era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )
    expect(summary.id).toBe(worldId)
    expect(summary.name).toBe(scope.worldName(0))
    expect(summary.concept).toBe('a concept')
    expect(summary.era).toBe('the late bronze age')

    // Critically — no plot column reaches the wire shape, under either
    // snake_case or camelCase.
    for (const k of [
      'key_tensions',
      'keyTensions',
      'political_summary',
      'politicalSummary',
      'world_overview',
      'worldOverview',
      'geography_summary',
      'geographySummary',
      'starting_situations',
      'startingSituations',
      'follow_up_questions',
      'followUpQuestions',
      'dev_bypass_access_filter',
      'devBypassAccessFilter',
    ]) {
      expect(k in summary).toBe(false)
    }
  })

  it('returns null for a world id that does not exist', async () => {
    const repo = createRepo(pool)
    const summary = await repo.worlds.getSnapshotSummary(uuidv7())
    expect(summary).toBeNull()
  })
})
