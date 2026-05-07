import pino from 'pino'

/**
 * Module-level pino instance for the LLM layer.
 *
 * Used by the middleware to emit structured `event: 'llm.call'` and
 * `event: 'llm.error'` log lines on every wrapped model call. Lives outside
 * Fastify request scope because the middleware fires from inside the SDK
 * call stack, which doesn't have a request context.
 *
 * Tests mock the SDK at the import boundary (`vi.mock('ai')`); they do not
 * need to mock this logger. If a test needs to assert log shape, it can
 * `vi.spyOn(logger, 'info')` / `vi.spyOn(logger, 'error')`.
 */
export const logger = pino({
  base: { component: 'llm' },
  level: process.env.LOG_LEVEL ?? 'info',
})
