// backend/src/session/dm-trigger-config.ts — MYT-67 §7. Shared by server (ws-session) + worker.
export const QUEUE_DM_TRIGGER = 'dm-trigger' as const
export const DM_TRIGGER_JOB_NAME = 'evaluate' as const
export const TYPING_HEARTBEAT_S = 3
export const TYPING_TTL_S = 8
export const QUIET_WINDOW_MS = 4_000
export const MAX_QUIET_EXTENSION_MS = 30_000
export const DEAD_AIR_MS = 60_000
export const DEDUP_TTL_MS = DEAD_AIR_MS + 4_000
export const MAX_BATCH = 30
export const CONFIDENCE_FLOOR = 0.8
export const DM_TRIGGER_CONCURRENCY = 5
export const DM_TRIGGER_LOCK_DURATION_MS = 90_000
export const DM_TRIGGER_STALLED_INTERVAL_MS = 90_000
export const DM_TRIGGER_MAX_STALLED_COUNT = 1
export const HAIKU_CLASSIFY_TIMEOUT_MS = 60_000
