// backend/src/queue/job-containment.ts
//
// Worker-resilience primitives shared across the queue processors.
//
// Two playtest incidents motivate this module:
//
//   myth-y2qfi (2026-07-19) — a session-prep Opus response hit the output
//   token cap; the resulting AI_NoObjectGeneratedError escaped its job as an
//   UNHANDLED PROMISE REJECTION (a detached `.then` chain inside the streaming
//   generate_object repair flow, not the processor's await path) and, under
//   Node's default `--unhandled-rejections=throw`, killed the ENTIRE worker
//   process — all nine queues, every in-flight job. One bad LLM response must
//   fail THAT JOB ONLY; the process must survive.
//
//   myth-3u4a0 (2026-07-17) — a character-creation job completed two LLM calls
//   then awaited SOMETHING forever; the BullMQ lock renewed indefinitely with
//   no stall detection, stranding the player's concept at 'processing'. Every
//   external await needs a hard timeout that surfaces a terminal job failure.
//
// The pieces:
//   - withJobTimeout           — a hard wall-clock bound on one external await.
//   - containProcessor         — processor-boundary containment (in-chain throws).
//   - createProcessEscapeGuard — the process-level net for FLOATING escapes.
//   - describeErrorForLog      — a secret-free error descriptor for logs.

import type { Job } from 'bullmq'

/** Structured pino slice — every helper here only logs at error level. */
export interface ContainmentLogger {
  error: (obj: Record<string, unknown>, msg?: string) => void
}

// ---------------------------------------------------------------------------
// withJobTimeout (myth-3u4a0)
// ---------------------------------------------------------------------------

/** The `.code` carried by a timeout error. `sanitizeError(err).code` surfaces
 *  it on the pipeline `stage-failed` event's `errorCode` field. */
export const JOB_TIMEOUT_CODE = 'job_timeout'

/**
 * Race one external await against a hard wall-clock timeout. On trip, throw the
 * cross-workstream unrecoverable-error shape — `{ terminal: true }` — so
 * `isTerminalError` routes it to the NO-RETRY path (the concept flips to
 * 'failed' and the player resubmits, rather than BullMQ re-attempting a hang
 * that will only hang again).
 *
 * The abandoned `work` promise keeps running in the background — Node cannot
 * cancel an in-flight await — but the job promise the caller awaits settles, so
 * the BullMQ lock is released and the worker slot is freed. Any late write from
 * the abandoned work is harmless: stage persistence is idempotent per
 * (campaign, user) and a retry's claim re-arms the row.
 */
export async function withJobTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            Object.assign(new Error(`${label} exceeded ${String(timeoutMs)}ms`), {
              terminal: true,
              code: JOB_TIMEOUT_CODE,
            }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    // The Promise executor runs synchronously, so `timer` is always set here;
    // clearTimeout tolerates undefined regardless (no dead branch).
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// containProcessor (myth-y2qfi, layer (a): the processor boundary)
// ---------------------------------------------------------------------------

/**
 * Wrap a BullMQ processor so ANY throw in its await chain — synchronous or
 * asynchronous — becomes a logged, contained job failure. The wrapper is an
 * async function, so a synchronous throw in `processor` is captured as a
 * rejection (never an uncaught exception), and a returned rejected promise is
 * caught, logged with a secret-free descriptor, and re-thrown so BullMQ marks
 * the job failed and applies its retry policy. Containment means "this job
 * fails", never "swallow silently".
 *
 * NOTE: this boundary CANNOT catch a promise that the processor never returns
 * into its own chain (a floating rejection detached from the await path — the
 * exact myth-y2qfi escape). That class is caught only by the process-level
 * guard below. The two layers are complementary, not redundant.
 */
export function containProcessor<T, R>(
  queue: string,
  processor: (job: Job<T>) => Promise<R>,
  logger: ContainmentLogger,
): (job: Job<T>) => Promise<R> {
  return async (job) => {
    try {
      return await processor(job)
    } catch (err) {
      logger.error(
        {
          component: 'worker',
          event: 'job.contained_failure',
          queue,
          jobId: job.id,
          jobName: job.name,
          err: describeErrorForLog(err),
        },
        'job failed at containment boundary',
      )
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// createProcessEscapeGuard (myth-y2qfi, layer (b): the process boundary)
// ---------------------------------------------------------------------------

/** Rolling window over which escapes are counted for the crash-loop hatch. */
const DEFAULT_ESCAPE_WINDOW_MS = 60_000
/** Escapes-within-window before the guard deliberately fails fast. Well above
 *  the isolated-per-job rate (one bad LLM response is a single escape) but far
 *  below a systemic storm where every job of a queue escapes. */
const DEFAULT_ESCAPE_THRESHOLD = 25

export interface ProcessEscapeGuardOptions {
  readonly logger: ContainmentLogger
  /** Fired when the storm threshold trips. Production wires this to a
   *  fail-fast `process.exit(1)`; injected so tests assert without exiting. */
  readonly onStorm: (info: { readonly count: number; readonly windowMs: number }) => void
  readonly windowMs?: number
  readonly threshold?: number
  /** While true the guard is a no-op — a rejection racing graceful teardown
   *  must not re-trigger the fail-fast exit. */
  readonly isShuttingDown?: () => boolean
  readonly now?: () => number
}

export interface ProcessEscapeGuard {
  readonly onUnhandledRejection: (reason: unknown) => void
  readonly onUncaughtException: (err: unknown) => void
  /** Register the handlers on `process`; returns a disposer that removes them. */
  install: () => () => void
}

/**
 * The last line of defence for a job-level failure that escapes EVERY job
 * boundary — a floating unhandled rejection (myth-y2qfi) or an uncaught
 * synchronous exception.
 *
 * CRASH-LOOP vs ZOMBIE — the deliberate decision:
 *
 *   Default posture is KEEP-ALIVE. A single escaped rejection/exception is
 *   overwhelmingly a per-job defect (like the ai.ts streaming-repair floating
 *   promise), not corruption of the worker's shared, process-scoped state (the
 *   pg Pool, the Redis clients, the nine BullMQ workers) — a job's LLM-parse
 *   failure does not mutate those. Continuing preserves the eight healthy
 *   queues, which is the ENTIRE point of the incident: one bad job in one queue
 *   must not orphan the other eight. This is a deliberate departure from the
 *   generic "always exit on uncaughtException" advice, justified by the
 *   multi-queue isolation requirement and bounded by the hatch below. (During
 *   graceful shutdown the guard no-ops via isShuttingDown so a teardown-race
 *   rejection can't re-enter.)
 *
 *   The ZOMBIE risk is that a SYSTEMIC bug escapes on every job: the process
 *   stays "healthy" per the health check while silently failing that queue's
 *   work, and ops sees only a log trickle, no crash alarm. So a rolling-window
 *   escape hatch trips `onStorm` (→ exit non-zero) once escapes exceed the
 *   threshold, converting a silent zombie into a loud crash-loop that ECS
 *   restarts and that alarms fire on. Isolated escapes survive; a storm fails
 *   fast. That is the crash-loop-vs-zombie tradeoff, resolved.
 */
export function createProcessEscapeGuard(opts: ProcessEscapeGuardOptions): ProcessEscapeGuard {
  const windowMs = opts.windowMs ?? DEFAULT_ESCAPE_WINDOW_MS
  const threshold = opts.threshold ?? DEFAULT_ESCAPE_THRESHOLD
  const now = opts.now ?? Date.now
  const isShuttingDown = opts.isShuttingDown ?? ((): boolean => false)
  const recent: number[] = []
  let stormFired = false

  function record(kind: 'unhandledRejection' | 'uncaughtException', err: unknown): void {
    if (isShuttingDown()) return
    const t = now()
    recent.push(t)
    while (recent.length > 0 && recent[0]! <= t - windowMs) recent.shift()
    opts.logger.error(
      {
        component: 'worker',
        event: 'process.escape',
        kind,
        count: recent.length,
        err: describeErrorForLog(err),
      },
      'contained a process-level escape; worker stays alive',
    )
    if (recent.length > threshold && !stormFired) {
      stormFired = true
      opts.logger.error(
        { component: 'worker', event: 'process.escape_storm', kind, count: recent.length, windowMs },
        'process-level escapes exceeded threshold; failing fast to avoid a zombie worker',
      )
      opts.onStorm({ count: recent.length, windowMs })
    }
  }

  const onUnhandledRejection = (reason: unknown): void => {
    record('unhandledRejection', reason)
  }
  const onUncaughtException = (err: unknown): void => {
    record('uncaughtException', err)
  }

  return {
    onUnhandledRejection,
    onUncaughtException,
    install(): () => void {
      process.on('unhandledRejection', onUnhandledRejection)
      process.on('uncaughtException', onUncaughtException)
      return () => {
        process.off('unhandledRejection', onUnhandledRejection)
        process.off('uncaughtException', onUncaughtException)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// describeErrorForLog
// ---------------------------------------------------------------------------

export interface LoggedErrorDescriptor {
  readonly name: string
  readonly code: string | null
  readonly terminal: boolean
  readonly message: string
}

/** Max logged message length. Our typed errors carry class-level messages
 *  (e.g. "llm returned unparseable structured output"); the cap is a hard wall
 *  against a data-bearing message from an unexpected error type. */
const MAX_LOG_MESSAGE_LEN = 120

/**
 * A secret-free descriptor of an arbitrary throw, for structured logs.
 *
 * The secret-bearing surface on our LLM errors is `diagnostic.rawTextSnippet`
 * (verbatim model output — for session-prep that is the sd_playbook, which
 * carries NPC secrets). This descriptor keeps ONLY the stable, secret-free
 * scalars — class name, `.code`, the terminal flag, and a hard-capped message —
 * and drops `diagnostic`, `cause`, and `stack` entirely.
 */
export function describeErrorForLog(err: unknown): LoggedErrorDescriptor {
  if (err instanceof Error) {
    const rawCode = (err as { code?: unknown }).code
    return {
      name: err.name,
      code: typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : null,
      terminal: (err as { terminal?: unknown }).terminal === true,
      message: err.message.slice(0, MAX_LOG_MESSAGE_LEN),
    }
  }
  return { name: 'NonError', code: null, terminal: false, message: String(err).slice(0, MAX_LOG_MESSAGE_LEN) }
}
