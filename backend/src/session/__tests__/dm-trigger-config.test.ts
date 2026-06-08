import { describe, it, expect } from 'vitest'
import * as cfg from '../dm-trigger-config.js'

describe('dm-trigger-config', () => {
  it('exposes the trigger timing constants with the spec invariants', () => {
    expect(cfg.QUEUE_DM_TRIGGER).toBe('dm-trigger')
    expect(cfg.QUIET_WINDOW_MS).toBe(4000)
    expect(cfg.DEAD_AIR_MS).toBe(60_000)
    expect(cfg.MAX_QUIET_EXTENSION_MS).toBe(30_000)
    expect(cfg.TYPING_TTL_S).toBe(8)
    expect(cfg.TYPING_HEARTBEAT_S).toBe(3)
    expect(cfg.CONFIDENCE_FLOOR).toBe(0.8)
    expect(cfg.MAX_BATCH).toBeGreaterThan(0)
    expect(cfg.HAIKU_CLASSIFY_TIMEOUT_MS).toBeLessThan(cfg.DM_TRIGGER_LOCK_DURATION_MS)
    expect(cfg.DEDUP_TTL_MS).toBeGreaterThan(cfg.DEAD_AIR_MS)
    expect(cfg.TYPING_TTL_S).toBeGreaterThan(2 * cfg.TYPING_HEARTBEAT_S)
  })
})
