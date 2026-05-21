import pino from 'pino'

/**
 * Module-level pino instance for the LLM layer.
 *
 * Used by the middleware to emit structured `event: 'llm.call'` and
 * `event: 'llm.error'` log lines on every wrapped model call. Lives outside
 * Fastify request scope because the middleware fires from inside the SDK
 * call stack, which doesn't have a request context.
 *
 * Constructed against `pino.destination({sync: true})` so synchronous
 * writes block until the OS write() returns. This is the documented pino
 * mechanism for the "exit problem" — when the process-level
 * unhandledRejection handler (see backend/src/boot/process-error-handlers.ts)
 * logs and then immediately process.exit(1)s, the final diagnostic has
 * already left the process and is in the kernel pipe (dev) or the Docker
 * stdout stream (prod) where ECS's awslogs driver picks it up. Throughput
 * cost vs async is negligible at our log volume; pino docs explicitly
 * support sync mode for our use case.
 *
 * Tests mock the SDK at the import boundary (`vi.mock('ai')`); they do not
 * need to mock this logger. If a test needs to assert log shape, it can
 * `vi.spyOn(logger, 'info')` / `vi.spyOn(logger, 'error')`.
 */
export const logger = pino(
  {
    base: { component: 'llm' },
    level: process.env.LOG_LEVEL ?? 'info',
  },
  pino.destination({ sync: true }),
)
