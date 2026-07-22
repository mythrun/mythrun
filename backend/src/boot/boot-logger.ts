import pino from 'pino'

/**
 * Boot-sequence logger for server.ts's probe gate and fatal boot paths.
 *
 * Structured JSON like everything else that reaches the awslogs driver
 * (the boot checkmarks were previously bare console.log lines — the one
 * unstructured island in the log stream), with the same sync-destination
 * posture as llm/logger.ts: boot failures process.exit(1) immediately, so
 * the final line must already be flushed when the process dies.
 *
 * Tests assert boot-gate messages via `vi.spyOn(bootLogger, 'error')` —
 * the same pattern llm/logger.ts documents.
 */
export const bootLogger = pino(
  { base: { component: 'boot' }, level: process.env.LOG_LEVEL ?? 'info' },
  pino.destination({ sync: true }),
)
