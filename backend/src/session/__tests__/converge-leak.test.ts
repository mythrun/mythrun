// backend/src/session/__tests__/converge-leak.test.ts
//
// myth-3jna1 — the enforced-ignorance LEAK MATRIX for the convergence steer.
// The steer adds a NEW secret-side judgment to the session loop: a Haiku call
// that reads the whole sd_playbook and answers "how far through the intended
// arc is this table?". That number, and the reasoning behind it, are secret
// material — they exist only because the playbook exists. The player-facing
// progress number is the MECHANICAL one and is computed elsewhere; these two
// must never touch.
//
// The five links of the boundary, each proven by a case:
//   (a) The probe IS fed the whole playbook — it cannot judge an arc without
//       it. (The positive control: without this the rest proves nothing.)
//   (b) The converge signal reaches the ST as a BOOLEAN. Not the fraction, not
//       the basis prose — even when the probe's output carries the secret
//       verbatim, the director input carries neither.
//   (c) A converging cycle writes the SAME three channels with the SAME
//       ST-authored text as any other cycle. The steer opens no new channel,
//       so there is no new place for the number to escape through.
//   (d) The only ST output that crosses to the Fast Thinker is the standing
//       directive, rendered through the REAL buildModelMessages — the probe's
//       basis, the fraction, and the playbook render nowhere in the FT's
//       messages.
//   (e) Converge mode is INVISIBLE to the FT: a converging cycle and a
//       non-converging cycle that produce the same ST text produce
//       byte-identical FT messages. The FT cannot tell the difference, which
//       is what "the FT never learns why" means structurally.
//
// Mock posture: the real `processStEvalJob` runs against the shared recording
// harness with an INJECTED probe spy (`deps.runNarrativeProgress`) and an
// injected director spy — no LLM call, so every link is deterministic. The
// real-Haiku QUALITY of the judgment is a separate concern from this plumbing.

import { describe, expect, it } from 'vitest'
import { SESSION_FT_CONTEXT_BUDGET } from '../ft-config.js'
import { CONVERGE_MECHANICAL_FLOOR } from '../st-config.js'
import { processStEvalJob } from '../st-evaluation-worker.js'
import { buildModelMessages } from '../tiers/fast-thinker.js'
import type { FtTurnContext } from '../tiers/types.js'
import { job, makeHarness, progress } from './st-evaluation-worker-harness.js'

/** The sentinel secret. It lives in the playbook the probe reads, and its only
 *  legal destination is the probe's input and the director's input. */
const SECRET = 'the harbourmaster drowned the crew himself'
/** The probe's own reasoning, forced to carry the secret verbatim — a hostile
 *  probe output. Code must not forward it anywhere regardless. */
const PROBE_BASIS = `only one goal landed; ${SECRET} is still undiscovered`
const PLAYBOOK = `## Session Goals\nLand the reveal.\n\n## NPC Secrets\n${SECRET}`

/** Cumulative spend inside the convergence window with the arc badly behind. */
const AT_FLOOR = CONVERGE_MECHANICAL_FLOOR * SESSION_FT_CONTEXT_BUDGET
const NARRATIVE_LAGGING = 0.15

function convergingHarness(): ReturnType<typeof makeHarness> {
  return makeHarness({
    sdPlaybook: PLAYBOOK,
    totalUsed: AT_FLOOR,
    narrativeProgress: progress(NARRATIVE_LAGGING, 40, PROBE_BASIS),
  })
}

// ===========================================================================
// (a) the probe is fed the playbook — the positive control
// ===========================================================================

describe('myth-3jna1 leak matrix — (a) the probe reads the secret playbook', () => {
  it('the narrative-progress input carries the whole sd_playbook', async () => {
    const { deps, rec } = convergingHarness()
    await processStEvalJob(deps, job)
    expect(rec.progressInputs[0]?.sdPlaybook).toContain(SECRET)
  })
})

// ===========================================================================
// (b) the ST is told the MODE, never the MEASUREMENT
// ===========================================================================

describe('myth-3jna1 leak matrix — (b) the converge signal is a boolean', () => {
  it('the director input carries converge:true and nothing else from the probe', async () => {
    const { deps, rec } = convergingHarness()
    await processStEvalJob(deps, job)

    const input = rec.directorInputs[0]
    expect(input?.converge).toBe(true)

    const keys = Object.keys(input ?? {})
    expect(keys).not.toContain('progress')
    expect(keys).not.toContain('narrativeProgress')
    expect(keys).not.toContain('mechanicalProgress')
    expect(keys).not.toContain('basis')

    // The probe's reasoning never rides along. (The playbook itself DOES appear
    // in the director input — the ST holds it by design — so the assertion is
    // scoped to the probe's own output.)
    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain(PROBE_BASIS)
    expect(serialized).not.toContain(String(NARRATIVE_LAGGING))
  })
})

// ===========================================================================
// (c) the steer opens NO new channel
// ===========================================================================

describe('myth-3jna1 leak matrix — (c) a converging cycle writes the same channels', () => {
  it('one-shot / standing / summary carry the ST-authored text only', async () => {
    const { deps, rec } = convergingHarness()
    await processStEvalJob(deps, job)

    // The harness director returns 'D' / 'S' / 'updated running summary'.
    expect(rec.setOneShot).toEqual(['D'])
    expect(rec.setStanding).toEqual(['S'])
    expect(rec.setSummary).toEqual(['updated running summary'])

    const everythingWritten = JSON.stringify([rec.setOneShot, rec.setStanding, rec.setSummary])
    expect(everythingWritten).not.toContain(PROBE_BASIS)
    expect(everythingWritten).not.toContain(SECRET)
    expect(everythingWritten).not.toContain(String(NARRATIVE_LAGGING))
  })
})

// ===========================================================================
// (d) what crosses to the FT, rendered by the REAL renderer
// ===========================================================================

/** Build the FT's real turn context around a standing directive, as the turn
 *  worker does after reading the ST's standing slot. */
function ftMessagesFor(standingDirective: string): string {
  const ctx: FtTurnContext = {
    campaignId: 'c-converge',
    ftContext: 'A harbour town under grey rain.',
    ftHistory: [
      {
        v: 1,
        role: 'user',
        characterName: 'Vire',
        parts: [{ kind: 'text', text: 'I look for the harbourmaster.' }],
      },
    ],
    participants: ['Vire'],
    usage: { input: 0, output: 0 },
    workingSet: [],
    standingDirective,
  }
  return JSON.stringify(buildModelMessages(ctx))
}

describe('myth-3jna1 leak matrix — (d) the FT sees the direction, never the reason', () => {
  it('buildModelMessages renders the standing directive and nothing secret-side', async () => {
    const { deps, rec } = convergingHarness()
    await processStEvalJob(deps, job)

    const standing = rec.setStanding[0]
    expect(standing).toBeDefined()
    const serialized = ftMessagesFor(standing ?? '')

    // Positive control: the direction DID cross, on the documented seam.
    expect(serialized).toContain('[DM direction: S]')
    // Nothing else did.
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(PROBE_BASIS)
    expect(serialized).not.toContain(String(NARRATIVE_LAGGING))
    expect(serialized).not.toContain('converge')
  })
})

// ===========================================================================
// (e) converge mode is INVISIBLE to the FT
// ===========================================================================

describe('myth-3jna1 leak matrix — (e) the FT cannot tell a converging session apart', () => {
  it('same ST text → byte-identical FT messages whether or not the steer fired', async () => {
    const converging = convergingHarness()
    await processStEvalJob(converging.deps, job)
    expect(converging.rec.directorInputs[0]?.converge).toBe(true)

    // The same session, well below the convergence floor: no probe, no steer.
    const quiet = makeHarness({ sdPlaybook: PLAYBOOK, totalUsed: 1_000 })
    await processStEvalJob(quiet.deps, job)
    expect(quiet.rec.progressInputs).toHaveLength(0)
    expect(quiet.rec.directorInputs[0]?.converge).toBe(false)

    expect(ftMessagesFor(converging.rec.setStanding[0] ?? '')).toBe(
      ftMessagesFor(quiet.rec.setStanding[0] ?? ''),
    )
  })
})
