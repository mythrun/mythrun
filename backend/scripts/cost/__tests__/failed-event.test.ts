// backend/scripts/cost/__tests__/failed-event.test.ts
//
// The `cost_smoke.failed` structured failure signal (plan Task 8: the weekly
// ECS run alarms on this line; emission is the runner's job). One emitter,
// two failure paths: an asserted row failing (exit-1 with a report) and the
// crash handler (any thrown error). Pino-llm.call idiom: flat JSON to
// stdout, `component`/`event` discriminators, epoch-ms `time`.

import { describe, expect, it } from 'vitest'
import { costSmokeFailedLine } from '../failed-event.js'

describe('costSmokeFailedLine', () => {
  it('renders the assertion-failure path with the failed row keys', () => {
    const line = costSmokeFailedLine({
      scenario: 's1',
      reason: 'assertion_failed',
      failedComponents: ['s1.st_eval_count', 's1.ft_usd_per_turn'],
    })
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed).toMatchObject({
      level: 50,
      component: 'cost',
      event: 'cost_smoke.failed',
      scenario: 's1',
      reason: 'assertion_failed',
      failedComponents: ['s1.st_eval_count', 's1.ft_usd_per_turn'],
      msg: 'cost smoke failed',
    })
    expect(typeof parsed.time).toBe('number')
    expect(line.endsWith('\n')).toBe(false)
  })

  it('renders the crash path with the error message and no row keys', () => {
    const parsed = JSON.parse(
      costSmokeFailedLine({
        scenario: 's4',
        reason: 'crashed',
        error: new Error('missing manifest key "s4.total_usd"'),
      }),
    ) as Record<string, unknown>
    expect(parsed).toMatchObject({
      level: 50,
      component: 'cost',
      event: 'cost_smoke.failed',
      scenario: 's4',
      reason: 'crashed',
      err: 'missing manifest key "s4.total_usd"',
    })
    expect(parsed).not.toHaveProperty('failedComponents')
  })

  it('stringifies non-Error throws and unknown scenarios safely', () => {
    const parsed = JSON.parse(
      costSmokeFailedLine({ scenario: 'unknown', reason: 'crashed', error: 'boom' }),
    ) as Record<string, unknown>
    expect(parsed.scenario).toBe('unknown')
    expect(parsed.err).toBe('boom')
  })
})
