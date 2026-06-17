// backend/src/session/__tests__/analysis-leak.test.ts
//
// MYT-74b — the ENFORCED-IGNORANCE LEAK MATRIX for the POST-SESSION ANALYSIS
// closeout. The analysis worker reads a session's transcript tail + the prep
// `sd_playbook` + the Redis running summary (all SECRET-bearing), runs ONE Opus
// call, MECHANICALLY verifies the handoff's verbatim excerpts against the
// transcript (containment.ts), and persists `{summary, emergingThreads}`
// (secret-free) + `handoff` (secret-aware). The next session's prep then
// DETERMINISTICALLY appends the handoff's verbatim NPC `voice` + location
// `atmosphere` onto `ft_context` (buildReturningVoicesSection).
//
// The novel enforced-ignorance surface this matrix guards: a `[[DM CORRECTION:]]`
// retcon line (trigger_kind='correction') or a FABRICATED quote must NEVER
// survive containment into a voice/atmosphere excerpt → so it can NEVER reach the
// next session's ft_context (where the Fast Thinker would read it). The
// containment verifier is the mechanical chokepoint (the explicit ZFC policy
// exception — structural substring validation, NO LLM judgment).
//
// Mirrors reconcile-leak.test.ts (MYT-74a): ONE unmistakable SECRET sentinel
// checked in every assertion, break-it-to-prove-it (a negative control proves the
// SECRET WAS present pre-verify, so the test proves the verifier removed it — not
// that it was never there), guardTestDatabase + createTestPool + makeTestScope /
// cleanupTestScope for the real-PG cases. The processor drives the REAL repo
// (listForAnalysis reads the seeded rows; writeAnalysis persists) + the REAL
// containment verifier; only `runAnalysis` (the non-deterministic Opus call) and
// `sessionState.loadTurnState` are injected fakes. The real-Opus QUALITY (a
// secret-free SUMMARY) is proven separately by the gated smoke
// (myt-74b-analysis-smoke).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

import {
  processPostSessionAnalysisJob,
  type AnalysisProcessorDeps,
} from '../post-session-analysis.js'
import { verifyHandoffContainment } from '../analysis/containment.js'
import { buildReturningVoicesSection } from '../../llm/prep/session-prep-processor.js'
import type { PostSessionAnalysisOutput } from '../../llm/post-session-analysis.js'
import type { PostSessionAnalysis, SessionHandoff } from '../../llm/schemas/post-session-analysis.js'

// The ONE unmistakable SECRET sentinel every leak assertion checks. It appears
// ONLY in a `correction` transcript row / the `sd_playbook` — NEVER in a legit
// player-witnessed (trigger_kind 'auto'/'explicit'/null) row. If this exact
// string survives into a persisted voice excerpt or the rendered ft_context
// section, the enforced-ignorance boundary the containment verifier exists to
// gate has leaked.
const SECRET = 'XYZZY-PLOT-SENTINEL'

// A legit, late-session relational DM line (trigger_kind 'auto') — the kind of
// verbatim voice excerpt that SHOULD survive containment into the next ft_context.
const LEGIT_VOICE = "You came back for me. I won't forget that."

// The retcon line: a [[DM CORRECTION:]] row whose prose carries the SECRET. Its
// trigger_kind='correction' makes containment EXCLUDE it from the haystack — so an
// excerpt copied from it can never be verified, and is dropped.
const CORRECTION_LINE = `[[DM CORRECTION: disregard the prior beat — ${SECRET} was never in the room.]]`

// A legit location atmosphere line that IS present verbatim in a normal row.
const LEGIT_ATMOSPHERE = 'Rain sheets off the broken eaves and the lantern gutters in the wind.'

const databaseUrl = process.env.DATABASE_URL ?? ''

// ---------------------------------------------------------------------------
// Builders. A handoff is "valid prose, mutated at exactly one seam" so a schema
// drift surfaces here.
// ---------------------------------------------------------------------------

function handoff(over: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    party: [{ characterName: 'Mara', location: 'the ruined chapel', condition: 'shaken but unhurt' }],
    timeOfDay: 'storm-dark evening',
    unresolvedThreads: ['who left the chapel door unbarred'],
    npcs: [{ name: 'Bram', state: 'newly loyal to the party', voice: [CORRECTION_LINE, LEGIT_VOICE] }],
    keyLocations: [{ name: 'the ruined chapel', atmosphere: LEGIT_ATMOSPHERE }],
    ...over,
  }
}

function analysisResult(over: Partial<PostSessionAnalysis> = {}): PostSessionAnalysis {
  return {
    summary: 'The party sheltered in the ruined chapel and earned Bram’s trust.',
    emergingThreads: ['who unbarred the chapel door'],
    handoff: handoff(),
    ...over,
  }
}

function analysisOut(result: PostSessionAnalysis): PostSessionAnalysisOutput {
  return {
    result,
    usage: { totalTokens: 700 } as unknown as PostSessionAnalysisOutput['usage'],
    repairAttempted: false,
  }
}

/** A loadTurnState fake — the running summary is irrelevant to containment (the
 *  verifier reads the transcript rows), so a constant '' is fine. */
function fakeSessionState(): AnalysisProcessorDeps['sessionState'] {
  return {
    loadTurnState: () => Promise.resolve({ summary: '', usage: { input: 0, output: 0 } }),
  }
}

/** Build the processor deps with the REAL repo + REAL containment verifier and an
 *  INJECTED `runAnalysis` returning a fixed handoff. The repo reads the seeded
 *  transcript (listForAnalysis) and persists (writeAnalysis); the verifier is the
 *  real chokepoint; only the non-deterministic Opus call is faked. */
function makeDeps(
  repo: Repo,
  result: PostSessionAnalysis,
  logger: AnalysisProcessorDeps['logger'],
): AnalysisProcessorDeps {
  return {
    repo,
    sessionState: fakeSessionState(),
    runAnalysis: () => Promise.resolve(analysisOut(result)),
    verify: verifyHandoffContainment,
    logger,
  }
}

function spyLogger(): AnalysisProcessorDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Concatenate every argument passed to a vi.fn logger method into one string. */
function loggerCallsToString(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((args) => JSON.stringify(args)).join(' ')
}

// ===========================================================================
// Real-PG suite. Scoped fixtures over mythrun_test; the LLM (runAnalysis) is the
// only injected fake — the repo read/write + the containment verifier are real.
// ===========================================================================

interface Seed {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly sessionId: string
}

describe('MYT-74b analysis leak matrix (real PG + real verifier + injected Opus)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('analysis-leak')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  /** Seed user → world → campaign → session ('active', summary NULL so the
   *  writeAnalysis gate opens). sessionNumber is fixed so the processor's
   *  sessionPreps.getBy lookup is deterministic (no prep seeded → sdPlaybook
   *  defaults to '', which the processor tolerates). */
  async function seed(): Promise<Seed> {
    const userId = uuidv7()
    const worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [uuidv7(), worldId, userId, scope.campaignName(0)],
    )
    const campaignId = campaign.rows[0]?.id
    if (!campaignId) throw new Error('campaign insert returned no id')
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active') RETURNING id`,
      [uuidv7(), campaignId],
    )
    const sessionId = sess.rows[0]?.id
    if (!sessionId) throw new Error('session insert returned no id')
    return { userId, worldId, campaignId, sessionId }
  }

  /** Seed the transcript: a normal late-session relational DM row (trigger_kind
   *  'auto') carrying LEGIT_VOICE + LEGIT_ATMOSPHERE, plus a `correction` row
   *  (trigger_kind 'correction') carrying the SECRET. Each `appendDmTurn` is its
   *  own turn (distinct turnId) so the ON CONFLICT (turn_id, turn_ordinal) gate
   *  doesn't collapse them. Seqs are caller-allocated and monotonic. */
  async function seedTranscript(sessionId: string): Promise<void> {
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: uuidv7(),
      rows: [
        { kind: 'dm_text', content: LEGIT_VOICE },
        { kind: 'dm_text', content: LEGIT_ATMOSPHERE },
      ],
      seqs: [1, 2],
      triggerKind: 'auto',
    })
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: uuidv7(),
      rows: [{ kind: 'dm_text', content: CORRECTION_LINE }],
      seqs: [3],
      triggerKind: 'correction',
    })
  }

  /** Read the persisted handoff back from the sessions.handoff column. */
  async function readPersistedHandoff(sessionId: string): Promise<SessionHandoff> {
    const row = await repo.sessions.getById(sessionId)
    if (!row) throw new Error('expected the session row after writeAnalysis')
    if (row.handoff === null) throw new Error('expected a persisted handoff')
    return JSON.parse(row.handoff) as SessionHandoff
  }

  // -------------------------------------------------------------------------
  // Case A — transcript → ft_context retcon leak (the NOVEL surface).
  //
  // The injected handoff's NPC voice carries the SECRET-bearing correction line
  // FIRST and the legit relational line SECOND. The real containment verifier
  // (driven through the real processor over the seeded transcript) drops the
  // correction line (it lives only in an EXCLUDED correction row) and keeps the
  // legit line. Then the deterministic ft_context injector renders the legit line
  // and NOT the SECRET — proving the retcon can't reach the next session's FT.
  // -------------------------------------------------------------------------

  it('Case A — a correction-row SECRET in an NPC voice is dropped by containment, never reaching ft_context; the legit line survives', async () => {
    const s = await seed()
    await seedTranscript(s.sessionId)

    // NEGATIVE CONTROL: the RAW (pre-verify) handoff voice DID carry the SECRET —
    // so the test proves the verifier removed it, not that it was never there.
    const raw = analysisResult()
    expect(raw.handoff.npcs[0]?.voice).toContain(CORRECTION_LINE)
    expect(JSON.stringify(raw.handoff)).toContain(SECRET)

    const logger = spyLogger()
    await processPostSessionAnalysisJob(makeDeps(repo, raw, logger), {
      data: { campaignId: s.campaignId, sessionId: s.sessionId },
    })

    // The persisted handoff: the SECRET/correction line is DROPPED; the legit
    // relational line is KEPT; the legit atmosphere is KEPT.
    const persisted = await readPersistedHandoff(s.sessionId)
    const voice = persisted.npcs[0]?.voice ?? []
    expect(voice).toContain(LEGIT_VOICE)
    expect(voice).not.toContain(CORRECTION_LINE)
    expect(JSON.stringify(persisted)).not.toContain(SECRET)
    expect(persisted.keyLocations[0]?.atmosphere).toBe(LEGIT_ATMOSPHERE)

    // The deterministic ft_context injector renders the legit line + atmosphere
    // verbatim and contains NO SECRET — the retcon never reaches the next FT.
    const section = buildReturningVoicesSection(persisted)
    expect(section).toContain(LEGIT_VOICE)
    expect(section).toContain(LEGIT_ATMOSPHERE)
    expect(section).not.toContain(SECRET)
    expect(section).not.toContain(CORRECTION_LINE)
  })

  // -------------------------------------------------------------------------
  // Case B — a FABRICATED quote (in NO transcript row) is dropped on persist.
  // -------------------------------------------------------------------------

  it('Case B — a fabricated voice excerpt present in no transcript row is dropped by containment', async () => {
    const s = await seed()
    await seedTranscript(s.sessionId)

    const fabricated = 'I have always known you would betray the crown.'
    const result = analysisResult({
      handoff: handoff({
        npcs: [{ name: 'Bram', state: 'newly loyal', voice: [fabricated, LEGIT_VOICE] }],
      }),
    })
    // NEGATIVE CONTROL: the raw voice carried the fabricated line pre-verify.
    expect(result.handoff.npcs[0]?.voice).toContain(fabricated)

    await processPostSessionAnalysisJob(makeDeps(repo, result, spyLogger()), {
      data: { campaignId: s.campaignId, sessionId: s.sessionId },
    })

    const persisted = await readPersistedHandoff(s.sessionId)
    const voice = persisted.npcs[0]?.voice ?? []
    expect(voice).toContain(LEGIT_VOICE)
    expect(voice).not.toContain(fabricated)
  })

  // -------------------------------------------------------------------------
  // Case C — the structural-only log surface. A forced drop logs the COUNT only;
  // NO logger argument carries the SECRET, the dropped voice content, or the
  // summary/handoff prose.
  // -------------------------------------------------------------------------

  it('Case C — a drop logs structural COUNTS only; no SECRET / dropped content / prose in any logger argument', async () => {
    const s = await seed()
    await seedTranscript(s.sessionId)

    const logger = spyLogger()
    // The default handoff (Case A shape) drops the SECRET correction line →
    // droppedVoice > 0 → the structural warn fires.
    await processPostSessionAnalysisJob(makeDeps(repo, analysisResult(), logger), {
      data: { campaignId: s.campaignId, sessionId: s.sessionId },
    })

    // A structural drop-warn fired carrying COUNTS.
    const warnMock = logger.warn as ReturnType<typeof vi.fn>
    const dropCall = warnMock.mock.calls.find(
      (args) => args[1] === 'analysis_excerpts_dropped_not_in_transcript',
    )
    expect(dropCall).toBeDefined()
    const payload = dropCall?.[0] as Record<string, unknown>
    expect(payload.droppedVoice).toBe(1)
    expect(payload.droppedAtmosphere).toBe(0)
    expect(payload.sessionId).toBe(s.sessionId)

    // ENFORCED IGNORANCE: across ALL THREE logger methods, no argument carries the
    // SECRET, the dropped correction prose, the legit voice/atmosphere, or the
    // summary/handoff prose — only structural counts/ids.
    const allErr = loggerCallsToString(logger.error as ReturnType<typeof vi.fn>)
    const allInfo = loggerCallsToString(logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(logger.warn as ReturnType<typeof vi.fn>)
    const all = `${allErr} ${allInfo} ${allWarn}`
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(CORRECTION_LINE)
    expect(all).not.toContain(LEGIT_VOICE)
    expect(all).not.toContain(LEGIT_ATMOSPHERE)
    expect(all).not.toContain('The party sheltered in the ruined chapel')
  })

  // -------------------------------------------------------------------------
  // Case D — the secret-free / secret-aware SPLIT persisted correctly. After a
  // clean run, the `summary` column JSON-parses to {summary, emergingThreads}
  // (NOT the handoff) and the `handoff` column is the separate SessionHandoff
  // JSON. Proves emergingThreads rides with the secret-free summary blob, not
  // inside the secret-aware handoff blob.
  // -------------------------------------------------------------------------

  it('Case D — summary column = {summary, emergingThreads}; handoff column = the separate SessionHandoff JSON', async () => {
    const s = await seed()
    await seedTranscript(s.sessionId)

    // A clean handoff whose voice + atmosphere are all verbatim-locatable (no
    // correction line) so nothing drops; emergingThreads is distinctive.
    const cleanThread = 'who unbarred the chapel door'
    const cleanSummary = 'The party sheltered in the ruined chapel and earned Bram’s trust.'
    const result = analysisResult({
      summary: cleanSummary,
      emergingThreads: [cleanThread],
      handoff: handoff({
        npcs: [{ name: 'Bram', state: 'newly loyal', voice: [LEGIT_VOICE] }],
        keyLocations: [{ name: 'the ruined chapel', atmosphere: LEGIT_ATMOSPHERE }],
      }),
    })

    await processPostSessionAnalysisJob(makeDeps(repo, result, spyLogger()), {
      data: { campaignId: s.campaignId, sessionId: s.sessionId },
    })

    // Read the two columns RAW (the repo getById exposes both as strings).
    const raw = await pool.query<{ summary: string | null; handoff: string | null }>(
      `SELECT summary, handoff FROM sessions WHERE id = $1`,
      [s.sessionId],
    )
    const summaryCol = raw.rows[0]?.summary
    const handoffCol = raw.rows[0]?.handoff
    if (typeof summaryCol !== 'string') throw new Error('expected a persisted summary column')
    if (typeof handoffCol !== 'string') throw new Error('expected a persisted handoff column')

    // The summary column is the secret-free {summary, emergingThreads} wrapper —
    // it does NOT carry the handoff blob.
    const summaryBlob = JSON.parse(summaryCol) as { summary: string; emergingThreads: string[] }
    expect(summaryBlob.summary).toBe(cleanSummary)
    expect(summaryBlob.emergingThreads).toEqual([cleanThread])
    expect(summaryCol).not.toContain('npcs')
    expect(summaryCol).not.toContain('keyLocations')

    // The handoff column is the separate SessionHandoff JSON — it carries the npcs
    // / keyLocations and NOT the emergingThreads recap field.
    const handoffBlob = JSON.parse(handoffCol) as SessionHandoff
    expect(handoffBlob.npcs[0]?.name).toBe('Bram')
    expect(handoffBlob.keyLocations[0]?.atmosphere).toBe(LEGIT_ATMOSPHERE)
    expect(handoffCol).not.toContain('emergingThreads')
    expect(handoffCol).not.toContain(cleanThread)
  })
})
