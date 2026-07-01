// backend/scripts/__tests__/world-color-backfill.test.ts
//
// MYT-87 T9: the colour backfill script. The MANDATORY backfill that gives
// every EXISTING `complete` world a `WorldColor` pair so the campaign hub never
// renders a default/ghost band for an already-generated world (the
// no-silent-stub-fallback guarantee). New worlds get their pair from the T8
// stage; this covers worlds generated before T8 existed.
//
// Two surfaces under test:
//   1. parseArgs — mutually-exclusive --world / --all (pure; no DB, no LLM).
//   2. runBackfill — a seeded complete-but-uncoloured world gets a WorldColor
//      pair after a `--world <id>` run, with the LLM MOCKED.
//
// Mock target: 'ai' (the Vercel SDK) `generateText` — the same upstream-mock
// pattern world-color.test.ts (the stage this script calls) uses. The script's
// runWorldColorStage → generateObject → sdkGenerateText path resolves the
// mocked pair; the persist runs against REAL Postgres so the assertion proves
// the end-to-end write, not just the arg-marshaling.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../src/repo/__tests__/_helpers/test-pool.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../src/repo/__tests__/_helpers/test-scope.js'
import { createRepo, type Repo } from '../../src/repo/index.js'
import { parseArgs, runBackfill } from '../world-color-backfill.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

// Seeded dev-user-2 (global-setup) — owns the fixture world so we don't have to
// create/clean a user; cleanupTestScope still removes the world by name prefix.
const DEV_USER_2 = '019700e0-0000-7000-8000-00000000d002'

// paper-50 <-> ember-900 = 9 rungs apart — clears the 5-rung floor on the first
// attempt (no re-roll), so a single mocked pair is the persisted pair.
const PASSING = { from: 'paper-50', to: 'ember-900' }

function mockPair(pair: { from: string; to: string }): void {
  mockGenerateText.mockResolvedValueOnce({
    output: pair,
    finishReason: 'stop',
    usage: { inputTokens: 800, outputTokens: 40, totalTokens: 840 },
  } as never)
}

describe('parseArgs (world-color-backfill)', () => {
  it('parses --world <id>', () => {
    expect(parseArgs(['--world', 'w1'])).toEqual({ worldId: 'w1', all: false, force: false })
  })

  it('parses --all --force', () => {
    expect(parseArgs(['--all', '--force'])).toEqual({ worldId: null, all: true, force: true })
  })

  it('rejects --world and --all together (mutually exclusive)', () => {
    expect(() => parseArgs(['--world', 'w1', '--all'])).toThrow(/mutually exclusive/)
  })

  it('rejects neither --world nor --all', () => {
    expect(() => parseArgs([])).toThrow(/exactly one/)
  })

  it('rejects --world with no id', () => {
    expect(() => parseArgs(['--world'])).toThrow(/requires an id/)
  })

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/)
  })
})

describe('runBackfill (world-color-backfill, integration)', () => {
  const databaseUrl = process.env.DATABASE_URL ?? ''
  let pool: Pool
  let repo: Repo
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('color-backfill')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await cleanupTestScope(pool, scope)
  })

  it('gives a seeded complete-but-uncoloured world a colour pair (--world <id>)', async () => {
    const world = await repo.worlds.create({
      createdBy: DEV_USER_2,
      name: scope.worldName(0),
      concept: 'A drowned archive where ink remembers the dead.',
      tone: 'melancholy, hushed',
      themes: 'memory, debt, water',
    })
    await repo.worlds.updateStatus(world.id, 'complete')

    // Precondition: complete but no colour pair yet.
    const before = await pool.query<{ color_from: string | null; color_to: string | null }>(
      `SELECT color_from, color_to FROM worlds WHERE id = $1`,
      [world.id],
    )
    expect(before.rows[0]).toEqual({ color_from: null, color_to: null })

    mockPair(PASSING)
    await runBackfill({ pool, repo }, { worldId: world.id, all: false, force: false })

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const after = await pool.query<{ color_from: string | null; color_to: string | null }>(
      `SELECT color_from, color_to FROM worlds WHERE id = $1`,
      [world.id],
    )
    expect(after.rows[0]).toEqual({ color_from: PASSING.from, color_to: PASSING.to })
  })
})
