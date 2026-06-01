// Queue identifiers + concurrency caps. The worker uses these to register
// Worker instances; the API will use the same identifiers to enqueue jobs.
// Concurrency caps follow spec §6 Queue Architecture: 3 for world-gen
// (Opus heavy), 5 for campaign-setup (per-player parallelism × 5 players).

export const QUEUE_WORLD_GEN = 'world-gen' as const
export const QUEUE_CAMPAIGN_SETUP = 'campaign-setup' as const
export const QUEUE_SESSION_PREP = 'session-prep' as const

export const CONCURRENCY_WORLD_GEN = 3
export const CONCURRENCY_CAMPAIGN_SETUP = 5
export const CONCURRENCY_SESSION_PREP = 3
