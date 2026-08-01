// backend/scripts/cost/lib/__tests__/extract.test.ts
//
// NDJSON `llm.call` extraction (cost-wave1 spec §1.0-1.1): dual-leg dev-log
// merge (dev-<date>.log API + dev-worker-<date>.log worker), midnight-spanning
// file naming, window + scope filtering, and the DROPS-AND-FLAGS arm — a line
// inside a session window (sessionId-attributed) carrying an unknown or
// world-gen stage is dropped, not silently priced into a session component.
// (Repair calls get re-stamped with world-gen stages via ai.ts extractStage,
// so this misattribution happens in real session windows.)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractCalls, logPathsForWindow, SESSION_STAGES } from '../extract.js'

const SESSION = 'sess-aaa'
const CAMPAIGN = 'camp-aaa'
const T = 1_785_500_000_000
const WINDOW = { fromMs: T, toMs: T + 60_000 }
const SCOPE = [SESSION, CAMPAIGN]

// Real pino line shape (see backend/logs/dev-*.log): flat bindings, epoch-ms
// `time`, `event: 'llm.call'` on the terminal success line.
function llmCall(fields: Record<string, unknown>): string {
  return JSON.stringify({
    level: 30,
    component: 'llm',
    event: 'llm.call',
    mode: 'generate',
    latencyMs: 1200,
    finishReason: 'stop',
    msg: 'llm call completed',
    ...fields,
  })
}

const API_LEG = [
  // Non-LLM + malformed traffic that real dev logs interleave — all skipped.
  JSON.stringify({ level: 30, time: T, component: 'boot', msg: '✓ Postgres ready' }),
  '../.env.worktree not found. Continuing without it.',
  '42',
  'null',
  JSON.stringify({ level: 30, time: T + 10, event: 'llm.call.started', model: 'claude-sonnet-5', mode: 'stream', sessionId: SESSION }),
  JSON.stringify({ level: 50, time: T + 20, event: 'llm.error', model: 'claude-sonnet-5', sessionId: SESSION, err: {} }),
  // Malformed llm.call lines — one per required-field guard.
  llmCall({ model: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, sessionId: SESSION }), // no time
  llmCall({ time: T + 30, inputTokens: 1, outputTokens: 1, sessionId: SESSION }), // no model
  llmCall({ time: T + 40, model: 'claude-sonnet-5', outputTokens: 1, sessionId: SESSION }), // no inputTokens
  llmCall({ time: T + 50, model: 'claude-sonnet-5', inputTokens: 1, sessionId: SESSION }), // no outputTokens
  // Boundary: exactly fromMs is IN.
  llmCall({ time: T, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'st_gate', inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }),
  // In-window session-stage call (API leg).
  llmCall({ time: T + 1_000, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'input_gate', inputTokens: 340, outputTokens: 17, cacheReadTokens: 0 }),
  // FT-shaped line: campaignId only, NO stage (fast-thinker stamps no stage) — kept.
  llmCall({ time: T + 2_000, model: 'claude-sonnet-5', mode: 'stream', campaignId: CAMPAIGN, inputTokens: 428_189, outputTokens: 10_405, cacheReadTokens: 388_010 }),
  // Out-of-window on both sides.
  llmCall({ time: T - 1, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, stage: 'st_gate', inputTokens: 9, outputTokens: 9 }),
  llmCall({ time: T + 60_001, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, stage: 'st_gate', inputTokens: 9, outputTokens: 9 }),
  // Out-of-scope: foreign ids, foreign session with no campaign, fully anonymous.
  llmCall({ time: T + 3_000, model: 'claude-haiku-4-5-20251001', sessionId: 'sess-zzz', campaignId: 'camp-zzz', stage: 'st_gate', inputTokens: 9, outputTokens: 9 }),
  llmCall({ time: T + 3_100, model: 'claude-haiku-4-5-20251001', sessionId: 'sess-zzz', stage: 'st_gate', inputTokens: 9, outputTokens: 9 }),
  llmCall({ time: T + 3_200, model: 'claude-haiku-4-5-20251001', inputTokens: 9, outputTokens: 9 }),
  // Boundary: exactly toMs is IN.
  llmCall({ time: T + 60_000, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'turn_audit', inputTokens: 200, outputTokens: 9, cacheReadTokens: 0 }),
].join('\n')

const WORKER_LEG = [
  // dm_trigger with NO cacheRead/cacheWrite fields — carried as undefined.
  llmCall({ time: T + 400, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'dm_trigger', inputTokens: 337, outputTokens: 9 }),
  // Session-attributed line with NO stage — kept (only lines CARRYING a foreign stage drop).
  llmCall({ time: T + 500, model: 'claude-sonnet-5', sessionId: SESSION, inputTokens: 50, outputTokens: 5 }),
  // st_eval with cacheRead AND cacheWrite; sessionId only (no campaignId).
  llmCall({ time: T + 1_500, model: 'claude-opus-5', mode: 'stream', sessionId: SESSION, stage: 'st_eval', inputTokens: 159_000, outputTokens: 2_200, cacheReadTokens: 12_000, cacheWriteTokens: 8_000 }),
  // DROPS-AND-FLAGS: a repair call re-stamped with a world-gen stage inside the
  // session window (ai.ts extractStage defaults unknown stages to concept_intake).
  llmCall({ time: T + 2_500, model: 'claude-sonnet-5', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'concept_intake', inputTokens: 5_000, outputTokens: 900 }),
  // DROPS-AND-FLAGS: an unknown stage inside the session window.
  llmCall({ time: T + 2_600, model: 'claude-haiku-4-5-20251001', sessionId: SESSION, campaignId: CAMPAIGN, stage: 'mystery_stage', inputTokens: 100, outputTokens: 10 }),
  // Prep-shaped line: campaignId only + world-gen stage — NOT session-attributed,
  // kept (this is exactly the S-4/S-5 shape).
  llmCall({ time: T + 2_700, model: 'claude-opus-5', mode: 'stream', campaignId: CAMPAIGN, stage: 'locations_and_npcs', inputTokens: 30_000, outputTokens: 8_000, cacheReadTokens: 0 }),
].join('\n')

let dirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cost-extract-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function writeLegs(dir: string): { api: string; worker: string } {
  const api = join(dir, 'dev-2026-07-30.log')
  const worker = join(dir, 'dev-worker-2026-07-30.log')
  writeFileSync(api, `${API_LEG}\n`)
  writeFileSync(worker, `${WORKER_LEG}\n`)
  return { api, worker }
}

describe('extractCalls', () => {
  it('merges both legs, filters to window + scope, and sorts by time', () => {
    const { api, worker } = writeLegs(makeDir())
    const { calls } = extractCalls([api, worker], WINDOW, SCOPE)
    expect(calls.map((c) => c.time)).toEqual([
      T, // st_gate boundary (api)
      T + 400, // dm_trigger (worker)
      T + 500, // stage-less session line (worker)
      T + 1_000, // input_gate (api)
      T + 1_500, // st_eval (worker)
      T + 2_000, // FT (api)
      T + 2_700, // prep line (worker)
      T + 60_000, // turn_audit boundary (api)
    ])
    // Multi-model run: each line keeps its own model for per-model pricing.
    expect(new Set(calls.map((c) => c.model))).toEqual(
      new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']),
    )
    // Full shape of the FT-baseline line survives extraction.
    expect(calls[5]).toEqual({
      time: T + 2_000,
      model: 'claude-sonnet-5',
      campaignId: CAMPAIGN,
      inputTokens: 428_189,
      outputTokens: 10_405,
      cacheReadTokens: 388_010,
    })
  })

  it('carries cacheRead/cacheWrite when present and leaves them undefined when missing', () => {
    const { api, worker } = writeLegs(makeDir())
    const { calls } = extractCalls([api, worker], WINDOW, SCOPE)
    const dmTrigger = calls.find((c) => c.stage === 'dm_trigger')
    expect(dmTrigger?.cacheReadTokens).toBeUndefined()
    expect(dmTrigger?.cacheWriteTokens).toBeUndefined()
    const stEval = calls.find((c) => c.stage === 'st_eval')
    expect(stEval?.cacheReadTokens).toBe(12_000)
    expect(stEval?.cacheWriteTokens).toBe(8_000)
  })

  it('drops-and-flags world-gen and unknown stages inside the session window', () => {
    const { api, worker } = writeLegs(makeDir())
    const { calls, dropped } = extractCalls([api, worker], WINDOW, SCOPE)
    expect(dropped.map((d) => [d.time, d.stage])).toEqual([
      [T + 2_500, 'concept_intake'],
      [T + 2_600, 'mystery_stage'],
    ])
    // The campaign-scoped prep line (no sessionId) is NOT session-attributed
    // and stays in calls — S-4/S-5 windows are made of exactly these lines.
    expect(calls.some((c) => c.stage === 'locations_and_npcs')).toBe(true)
  })

  it('skips paths that do not exist (legitimate for midnight-span candidates)', () => {
    const dir = makeDir()
    const { api, worker } = writeLegs(dir)
    const { calls } = extractCalls(
      [join(dir, 'dev-2026-07-29.log'), api, worker],
      WINDOW,
      SCOPE,
    )
    expect(calls).toHaveLength(8)
  })

  it('throws on empty scopeIds (scoping must never degrade to timestamps)', () => {
    const { api } = writeLegs(makeDir())
    expect(() => extractCalls([api], WINDOW, [])).toThrow(/scopeIds/)
  })

  it('throws on an invalid window', () => {
    const { api } = writeLegs(makeDir())
    expect(() => extractCalls([api], { fromMs: T + 1, toMs: T }, SCOPE)).toThrow(
      /invalid capture window/,
    )
    expect(() => extractCalls([api], { fromMs: Number.NaN, toMs: T }, SCOPE)).toThrow(
      /invalid capture window/,
    )
    expect(() => extractCalls([api], { fromMs: T, toMs: Number.NaN }, SCOPE)).toThrow(
      /invalid capture window/,
    )
  })
})

describe('logPathsForWindow', () => {
  it('returns both legs for a single-day window', () => {
    // Local-time construction mirrors dev-logged.sh's `date +%F` naming.
    const from = new Date(2026, 6, 30, 10, 0).getTime()
    const to = new Date(2026, 6, 30, 11, 0).getTime()
    expect(logPathsForWindow('/logs', { fromMs: from, toMs: to }).map((p) => basename(p))).toEqual([
      'dev-2026-07-30.log',
      'dev-worker-2026-07-30.log',
    ])
  })

  it('returns both legs for every date a midnight-spanning window touches', () => {
    const from = new Date(2026, 6, 30, 23, 50).getTime()
    const to = new Date(2026, 6, 31, 0, 10).getTime()
    expect(logPathsForWindow('/logs', { fromMs: from, toMs: to }).map((p) => basename(p))).toEqual([
      'dev-2026-07-30.log',
      'dev-worker-2026-07-30.log',
      'dev-2026-07-31.log',
      'dev-worker-2026-07-31.log',
    ])
  })

  it('extracts a midnight-spanning window across the dated files it names', () => {
    const dir = makeDir()
    const from = new Date(2026, 6, 30, 23, 50).getTime()
    const to = new Date(2026, 6, 31, 0, 10).getTime()
    const paths = logPathsForWindow(dir, { fromMs: from, toMs: to })
    // A call just before midnight in day 1's API leg; one just after midnight
    // in day 2's worker leg. Day 1's worker leg doesn't exist (stack quirk) —
    // extraction must tolerate that.
    writeFileSync(
      paths[0] ?? '',
      `${llmCall({ time: from + 1_000, model: 'claude-sonnet-5', sessionId: SESSION, stage: 'st_gate', inputTokens: 10, outputTokens: 1 })}\n`,
    )
    writeFileSync(
      paths[3] ?? '',
      `${llmCall({ time: to - 1_000, model: 'claude-sonnet-5', sessionId: SESSION, stage: 'turn_audit', inputTokens: 20, outputTokens: 2 })}\n`,
    )
    const { calls } = extractCalls(paths, { fromMs: from, toMs: to }, [SESSION])
    expect(calls.map((c) => [c.time, c.stage])).toEqual([
      [from + 1_000, 'st_gate'],
      [to - 1_000, 'turn_audit'],
    ])
  })
})

describe('SESSION_STAGES', () => {
  it('holds exactly the plan Task 1 per-session call-site labels', () => {
    expect([...SESSION_STAGES].sort()).toEqual(
      [
        'st_eval',
        'st_gate',
        'turn_audit',
        'dm_trigger',
        'secret_tripwire',
        'skill_check_dc',
        'input_gate',
        'profanity_gate',
        'st_narrative_progress',
        'st_lookup_vet',
        'world_lookup_gate',
        'session_reconcile',
        'post_session_analysis',
      ].sort(),
    )
  })
})
