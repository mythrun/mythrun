// backend/scripts/cost/failed-event.ts
//
// The `cost_smoke.failed` structured failure signal (spec §1.3 / plan Task
// 8): the weekly ECS run's alarm wiring matches this line in the captured
// stdout, so BOTH runner failure paths emit it — an asserted row failing
// (the exit-1 path under a printed report) and the crash handler (liveness
// refusal, driver error, missing manifest key, anything thrown). Pino
// llm.call idiom: flat JSON, `component`/`event` discriminators, epoch-ms
// `time`, level 50.

export interface CostSmokeFailedInput {
  readonly scenario: string
  readonly reason: 'assertion_failed' | 'crashed'
  /** Failed row component keys (assertion path only). */
  readonly failedComponents?: readonly string[]
  /** The thrown value (crash path only). */
  readonly error?: unknown
}

function errText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    // JSON.stringify's lib typing says string, but symbols/functions really
    // return undefined at runtime — treat the result as unknown and check.
    const s: unknown = JSON.stringify(error)
    return typeof s === 'string' ? s : 'unstringifiable'
  } catch {
    return Object.prototype.toString.call(error)
  }
}

export function costSmokeFailedLine(input: CostSmokeFailedInput): string {
  return JSON.stringify({
    level: 50,
    time: Date.now(),
    component: 'cost',
    event: 'cost_smoke.failed',
    scenario: input.scenario,
    reason: input.reason,
    ...(input.failedComponents === undefined ? {} : { failedComponents: input.failedComponents }),
    ...(input.error === undefined ? {} : { err: errText(input.error) }),
    msg: 'cost smoke failed',
  })
}
