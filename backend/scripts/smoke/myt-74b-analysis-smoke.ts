// backend/scripts/smoke/myt-74b-analysis-smoke.ts
//
// MYT-74b — gated real-Opus CONSTRUCTED smoke for the POST-SESSION ANALYSIS →
// HANDOFF → next-prep consumption chain. Proves the plumbing + the enforced-
// ignorance guarantee that mocked unit tests CANNOT: against the REAL Opus
// analysis call, a finished session's transcript tail + the prep `sd_playbook` +
// the Redis running summary are folded into durable narrative state by the real
// wire-level path —
//   read durable inputs → analyze (real Opus runPostSessionAnalysis) → verify
//   (the PURE containment verifier) → persist (the conditional writeAnalysis gate)
//   → consume (getPriorContextForPrep → buildPriorSessionContext →
//   buildReturningVoicesSection deterministic ft_context injection).
//
// CONSTRUCTED STATE (feedback_constructed_state_smoke): we seed the DB to
// just-before-the-handler + invoke `processPostSessionAnalysisJob` directly with
// real Opus, rather than driving a full live WS session. The farewell-render /
// correction-turn path (where the [[DM CORRECTION:]] row + trigger_kind are
// WRITTEN) is the proven MYT-73 correction-turn pattern, covered by the turn-
// worker unit tests + the unconditional-finalize tests; THIS smoke proves the
// novel analysis→handoff→prep-consumption chain against real Opus.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing + leak checks — a secret-free summary persisted, the
// handoff persisted with at least one non-empty voice, EVERY persisted voice +
// atmosphere is a verbatim (normalized-substring) copy of a NON-correction
// transcript row, the SECRET/correction line reached no excerpt, and the
// deterministic ft_context injection is BYTE-IDENTICAL + secret-free. We LOG (not
// assert) the affect QUALITY of the excerpts — that's eval territory.
//
// Gated on ANTHROPIC_API_KEY: skips cleanly (exit 0) when absent. NO Voyage
// needed — analysis does not embed. Seeds + tears down its own scratch world/
// campaign/session in mythrun_dev (DATABASE_URL via the env-file flags), plus the
// Redis running-summary key. worlds.status is seeded 'generating'
// (worlds_status_check forbids 'ready'/'complete' for a scratch row).
//
// Run:  pnpm smoke:analysis

import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRedisClient } from '../../src/redis/client.js'
import { makeSessionState } from '../../src/redis/session-state.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { runPostSessionAnalysis } from '../../src/llm/post-session-analysis.js'
import { verifyHandoffContainment, type AnalysisTranscriptRow } from '../../src/session/analysis/containment.js'
import { processPostSessionAnalysisJob } from '../../src/session/post-session-analysis.js'
import { buildPriorSessionContext } from '../../src/llm/prep/prior-session-context.js'
import { buildReturningVoicesSection } from '../../src/llm/prep/session-prep-processor.js'
import type { SessionHandoff } from '../../src/llm/schemas/post-session-analysis.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-analysis-1'
const SESSION_NUMBER = 1

// The SECRET sentinel — a distinctive token that appears ONLY in (a) a
// `correction` transcript row (the retcon), (b) the prep `sd_playbook`, and (c)
// the Redis running summary (secret-adjacent ST notes). A leak = the persisted
// secret-free `summary`, ANY voice/atmosphere excerpt, or the rendered ft_context
// section contains it.
const SECRET = 'Vexillarch-the-hidden-heir'

interface Seeded {
  worldId: string
  campaignId: string
  sessionId: string
  userId: string
  characterId: string
}

/** Build Bram's relationship arc across several turns: EARLY neutral rows, then
 *  LATE warm/relational rows (verbatim voice candidates), a key LOCATION with
 *  sensory atmosphere in a normal row, and ONE correction row carrying the
 *  SECRET. The late warm lines + the atmosphere are what the analysis SHOULD
 *  surface; the correction line must NEVER survive containment. */
const NEUTRAL_EARLY = "Bram barely looks up from the ledger. \"State your business and be quick about it.\""
const WARM_LATE_1 = "Bram sets down the lantern and meets your eyes. \"You came back for me. After everything. I won't forget that — not while I draw breath.\""
const WARM_LATE_2 = "\"Take the back stair,\" Bram murmurs, pressing the cold iron key into your palm. \"And mind the third step. It remembers everything that's ever crossed it.\""
const LOCATION_ATMOSPHERE = 'Rain sheets off the broken eaves of the chapel, and the single lantern gutters in the draft, throwing long shadows across the salt-stained pews.'
const CORRECTION_LINE = `[[DM CORRECTION: disregard the prior beat — the heir ${SECRET} was never present in this scene; that was an error.]]`

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  const characterId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Analysis Smoke User', 'smoke-analysis-user'],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, tone, status)
     VALUES ($1, $2, $3, $4, $5, 'generating')`,
    [worldId, userId, 'SMOKE: analysis', 'A storm-wracked river chapel and a wary keeper.',
      'grounded high-fantasy, weathered and terse'],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, userId, 'SMOKE: analysis campaign'],
  )
  // The session is 'active' (summary NULL) so the writeAnalysis gate opens. We
  // flip it to 'ended' AFTER the analysis write so getPriorContextForPrep (which
  // requires status='ended' AND summary IS NOT NULL) surfaces it for the prep read.
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, $3, 'active')`,
    [sessionId, campaignId, SESSION_NUMBER],
  )

  // A PC + a session_participants link so listSessionParticipantCharacters
  // returns a non-empty roster (the analysis prompt names the party). characters
  // has no campaign_id column (migration 009); the join table carries membership.
  await pool.query(
    `INSERT INTO characters
       (id, user_id, name, level, class, species, background,
        str, dex, con, int, wis, cha, hit_points, max_hit_points, armor_class, proficiency_bonus)
     VALUES ($1, $2, 'Mara', 1, 'Ranger', 'Human', 'Outlander',
        12, 14, 12, 11, 13, 10, 11, 11, 13, 2)`,
    [characterId, userId],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id) VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, userId],
  )
  await pool.query(
    `INSERT INTO session_participants (id, session_id, user_id, character_id) VALUES ($1, $2, $3, $4)`,
    [uuidv7(), sessionId, userId, characterId],
  )

  // The prep row for this session number — its sd_playbook carries the SECRET (a
  // prep-only secret the analysis reasons over but must keep out of the recap).
  await pool.query(
    `INSERT INTO session_preps (id, campaign_id, session_number, ft_context, sd_playbook)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), campaignId, SESSION_NUMBER,
      'Opening scene: the party shelters in the river chapel as the storm breaks.',
      `SLOW-THINKER PLAYBOOK (SECRET): Bram is in truth ${SECRET}, the deposed heir hiding in plain ` +
        `sight as the chapel keeper. Never reveal this to players. Steer toward earned trust, not exposure.`],
  )

  return { worldId, campaignId, sessionId, userId, characterId }
}

/** Seed the transcript via appendDmTurn (each turn its own turnId so the ON
 *  CONFLICT (turn_id, turn_ordinal) gate doesn't collapse them). Seqs are
 *  caller-allocated + monotonic. The correction row carries trigger_kind
 *  'correction' so containment excludes it from the haystack. */
async function seedTranscript(repo: ReturnType<typeof createRepo>, sessionId: string): Promise<void> {
  // Turn 1 — early neutral beat + a player line.
  await repo.sessionMessages.append({
    sessionId, seq: 1, userId: null, messageType: 'player_message',
    content: 'We push open the chapel door against the storm and step inside, dripping.',
  })
  await repo.sessionMessages.appendDmTurn({
    sessionId, turnId: uuidv7(),
    rows: [
      { kind: 'dm_text', content: LOCATION_ATMOSPHERE },
      { kind: 'dm_text', content: NEUTRAL_EARLY },
    ],
    seqs: [2, 3], triggerKind: 'explicit',
  })
  // Turn 2 — a player line + the LATE warm/relational beat (voice candidates).
  await repo.sessionMessages.append({
    sessionId, seq: 4, userId: null, messageType: 'player_message',
    content: 'I crossed the flood to come back for you, Bram. I wasn’t going to leave you here.',
  })
  await repo.sessionMessages.appendDmTurn({
    sessionId, turnId: uuidv7(),
    rows: [
      { kind: 'dm_text', content: WARM_LATE_1 },
      { kind: 'dm_text', content: WARM_LATE_2 },
    ],
    seqs: [5, 6], triggerKind: 'auto',
  })
  // Turn 3 — the CORRECTION retcon carrying the SECRET (trigger_kind 'correction').
  await repo.sessionMessages.appendDmTurn({
    sessionId, turnId: uuidv7(),
    rows: [{ kind: 'dm_text', content: CORRECTION_LINE }],
    seqs: [7], triggerKind: 'correction',
  })
}

/** Normalize the same way containment.ts does — for the wire-level re-check. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('skipped: no key — ANTHROPIC_API_KEY absent (gated real-Opus analysis smoke)')
    return
  }
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const redis = createRedisClient(env.redisRealtimeUrl)
  // createRedisClient is lazyConnect + enableOfflineQueue:false (retry policy
  // lives in waitFor in prod). A smoke has no boot probe, so connect explicitly
  // before the first command, else the first op races the TCP connect and throws
  // "Stream isn't writeable" (reference_ioredis_bullmq_ping_race).
  await redis.connect()
  const sessionState = makeSessionState(redis, env.redisKeyPrefix)
  const repo = createRepo(pool)

  let worldId: string | undefined
  let campaignId: string | undefined
  let characterId: string | undefined
  try {
    const seeded = await seedWorld(pool)
    worldId = seeded.worldId
    campaignId = seeded.campaignId
    characterId = seeded.characterId
    await seedTranscript(repo, seeded.sessionId)
    log('seeded scratch world/campaign/session + transcript + prep', { ...seeded })

    // Set the Redis running summary — secret-adjacent ST notes mentioning SECRET.
    await sessionState.setRunningSummary(
      seeded.campaignId,
      `ST notes: the party is closing on Bram's trust. Bram (= ${SECRET}, the hidden heir) is ` +
        `softening but still fears exposure. Do not let the players learn his true identity yet.`,
    )
    log('set Redis running summary (secret-adjacent ST notes)')

    // ── RUN the REAL analysis worker (real Opus, real repo, real verifier). ──
    await processPostSessionAnalysisJob(
      {
        repo,
        sessionState,
        runAnalysis: runPostSessionAnalysis,
        verify: verifyHandoffContainment,
        logger,
      },
      { data: { campaignId: seeded.campaignId, sessionId: seeded.sessionId } },
    )
    log('processPostSessionAnalysisJob complete (real Opus)')

    // ── ASSERT (wire-level): read the persisted analysis back. ──
    const session = await repo.sessions.getById(seeded.sessionId)
    if (session === null) throw new Error('ASSERT: session row vanished after analysis')
    if (session.summary === null) {
      throw new Error('ASSERT: sessions.summary was not persisted (writeAnalysis gate did not fire)')
    }
    if (session.handoff === null) throw new Error('ASSERT: sessions.handoff was not persisted')

    const summaryBlob = JSON.parse(session.summary) as { summary: string; emergingThreads: string[] }
    const handoff = JSON.parse(session.handoff) as SessionHandoff
    log('persisted analysis', {
      summaryLen: summaryBlob.summary.length,
      emergingThreads: summaryBlob.emergingThreads.length,
      npcs: handoff.npcs.length,
      keyLocations: handoff.keyLocations.length,
      // LOG the prose so a human can eyeball quality (eval territory, not asserted).
      summary: summaryBlob.summary,
      voices: handoff.npcs.map((n) => ({ name: n.name, state: n.state, voice: n.voice })),
      atmospheres: handoff.keyLocations.map((l) => ({ name: l.name, atmosphere: l.atmosphere })),
    })

    // (a) SECRET-FREE summary — the semantic check the mocked leak test cannot do.
    if (summaryBlob.summary.includes(SECRET)) {
      throw new Error('ENFORCED-IGNORANCE LEAK — the player-facing summary contains the SECRET sentinel')
    }
    log('PASS — persisted summary is secret-free')

    // (b) The handoff has at least one NPC with a non-empty voice.
    const npcWithVoice = handoff.npcs.find((n) => n.voice.length > 0)
    if (npcWithVoice === undefined) {
      throw new Error('ASSERT: no handoff NPC carried a non-empty voice excerpt after analysis')
    }
    log('PASS — handoff carries a non-empty NPC voice', { npc: npcWithVoice.name, count: npcWithVoice.voice.length })

    // (c) WIRE-LEVEL containment re-proof: re-run the containment check against the
    //     actual listForAnalysis rows. EVERY persisted voice + atmosphere must be a
    //     normalized substring of a NON-correction transcript row; the SECRET /
    //     correction line must appear in NO excerpt.
    const rows = await repo.sessionMessages.listForAnalysis(seeded.sessionId, 160)
    const verifyRows: AnalysisTranscriptRow[] = rows.map((r) => ({ content: r.content, triggerKind: r.triggerKind }))
    const reVerified = verifyHandoffContainment(handoff, verifyRows)
    if (reVerified.droppedVoice > 0 || reVerified.droppedAtmosphere > 0) {
      throw new Error(
        `ASSERT: a persisted excerpt failed the wire-level containment re-check ` +
          `(droppedVoice=${String(reVerified.droppedVoice)}, droppedAtmosphere=${String(reVerified.droppedAtmosphere)}) ` +
          `— the persisted handoff carries an excerpt that is NOT a verbatim non-correction transcript line`,
      )
    }
    // Belt-and-braces: assert the correction-row haystack truly excludes the SECRET
    // (every excerpt is a substring of a non-correction row; the SECRET lives only
    // in the correction row + sd_playbook + running summary).
    const allExcerpts = [
      ...handoff.npcs.flatMap((n) => n.voice),
      ...handoff.keyLocations.map((l) => l.atmosphere),
    ]
    const leakingExcerpt = allExcerpts.find((e) => e.includes(SECRET))
    if (leakingExcerpt !== undefined) {
      throw new Error('ENFORCED-IGNORANCE LEAK — a persisted voice/atmosphere excerpt contains the SECRET')
    }
    // And confirm the correction line itself is in no excerpt (normalized).
    const normCorrection = normalize(CORRECTION_LINE)
    if (allExcerpts.some((e) => normalize(e).includes(normCorrection))) {
      throw new Error('ENFORCED-IGNORANCE LEAK — the correction retcon line survived into an excerpt')
    }
    log('PASS — every persisted excerpt is verbatim from a non-correction row; no SECRET, no correction line', {
      excerpts: allExcerpts.length,
    })

    // ── Flip the session to 'ended' so the prep prior-context read surfaces it. ──
    const ended = await repo.sessions.markEnded(seeded.sessionId)
    log('marked session ended for the prep read', { rowCount: ended })

    // ── (d) DETERMINISTIC INJECTION CHAIN: getPriorContextForPrep →
    //        buildPriorSessionContext → buildReturningVoicesSection. The section
    //        must contain each persisted voice + atmosphere BYTE-IDENTICAL and NO
    //        SECRET. ──
    const priorRows = await repo.sessions.getPriorContextForPrep(seeded.campaignId, 20)
    if (priorRows.length === 0) {
      throw new Error('ASSERT: getPriorContextForPrep returned no rows (the ended+analysed session was not surfaced)')
    }
    const priorContext = buildPriorSessionContext(priorRows)
    if (priorContext.latestHandoff === undefined) {
      throw new Error('ASSERT: buildPriorSessionContext did not parse a latestHandoff from the persisted row')
    }
    const section = buildReturningVoicesSection(priorContext.latestHandoff)
    log('built the deterministic ft_context returning-voices section', { sectionLen: section.length })

    for (const npc of handoff.npcs) {
      for (const v of npc.voice) {
        if (!section.includes(v)) {
          throw new Error(`ASSERT: a persisted voice excerpt is NOT byte-identical in the ft_context section: ${v}`)
        }
      }
    }
    for (const loc of handoff.keyLocations) {
      if (!section.includes(loc.atmosphere)) {
        throw new Error(`ASSERT: a persisted atmosphere is NOT byte-identical in the ft_context section: ${loc.atmosphere}`)
      }
    }
    if (section.includes(SECRET)) {
      throw new Error('ENFORCED-IGNORANCE LEAK — the rendered ft_context section contains the SECRET')
    }
    log('PASS — ft_context injection is byte-identical per excerpt and secret-free', {
      // LOG the previous summaries the prep would also receive (quality eyeball, not asserted).
      previousSummaries: priorContext.previousSummaries,
    })

    log('ALL PASS — real Opus analysis folded the transcript into a secret-free summary + a verbatim, ' +
      'containment-clean handoff, and the deterministic ft_context injection carried the voices/atmospheres ' +
      'byte-identical with no secret leak')
  } finally {
    // Teardown order respects the NON-cascade FKs. characters.user_id and
    // session_participants.character_id are NOT ON DELETE CASCADE (migration 009
    // only set characters.user_id NOT NULL), so: (1) delete the world — cascades
    // campaigns → campaign_characters + sessions → session_participants /
    // session_messages / session_preps, orphaning the characters row; (2) delete
    // the now-unreferenced characters row; (3) delete the user.
    if (worldId !== undefined) {
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    if (characterId !== undefined) {
      await pool.query(`DELETE FROM characters WHERE id = $1`, [characterId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    if (campaignId !== undefined) {
      // The Redis running-summary key is keyed by campaignId — reset the scratch spend/summary keys.
      await sessionState.resetSessionSpend(campaignId)
    }
    redis.disconnect()
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-Opus analysis smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
