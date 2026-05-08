import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import pino from 'pino'
import { uuidv7 } from '../repo/uuidv7.js'
import { installSignalHandlers } from '../boot/signal-handlers.js'
import { loadEnv } from '../config/env.js'
import { LOCK_KEY } from './lock-key.js'
import { createPgPool } from './postgres.js'

const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}

const FORBIDDEN_RE = /^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;?\s*$/i

/**
 * Reject top-level transaction-control statements. Dollar-quote-aware:
 * PL/pgSQL bodies (`DO $$ BEGIN ... END $$`, `CREATE FUNCTION ... AS $$ ... $$`)
 * contain literal BEGIN/END and must not be falsely rejected.
 */
export function validateNoTransactionStatements(filename: string, contents: string): void {
  // Strip dollar-quoted runs in place by replacing them with newlines so line
  // numbers are preserved for error messages.
  const stripped = stripDollarQuoted(contents)
  const lines = stripped.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    // Strip line comment.
    const noComment = raw.replace(/--.*$/, '').trim()
    if (noComment === '') continue
    const match = FORBIDDEN_RE.exec(noComment)
    if (match) {
      const token = (match[1] ?? '').toUpperCase()
      const lineNo = String(i + 1)
      throw new Error(
        `migration ${filename} contains forbidden top-level transaction statement '${token}' at line ${lineNo}. ` +
          `The runner wraps each file in BEGIN/COMMIT; nested transaction control is not allowed. ` +
          `Remove the statement or split into a separate file.`,
      )
    }
  }
}

/**
 * Replace each dollar-quoted block with a same-line-count newline run.
 * Tags: $$, $tag$, $custom_tag$ — must match opening to closing tag exactly.
 * Preserves source-line numbering so validator error messages stay useful.
 */
function stripDollarQuoted(input: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    if (input[i] === '$') {
      // Try to match an opening tag: $tag$
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      const fullTag = tagMatch?.[0] // e.g. "$$" or "$body$"
      if (fullTag !== undefined) {
        const closeIdx = input.indexOf(fullTag, i + fullTag.length)
        if (closeIdx >= 0) {
          // Replace the dollar-quoted run with newlines matching the count
          // of newlines inside it, preserving line numbers.
          const inner = input.slice(i, closeIdx + fullTag.length)
          const newlineCount = (inner.match(/\n/g) ?? []).length
          out += '\n'.repeat(newlineCount)
          i = closeIdx + fullTag.length
          continue
        }
      }
    }
    out += input[i] ?? ''
    i++
  }
  return out
}

export type MigrateLogger = Pick<pino.BaseLogger, 'info' | 'warn' | 'error' | 'debug'>

export interface AppliedMigration {
  readonly version: string
  readonly durationMs: number
}

export interface MigrationOptions {
  readonly pool: Pool
  readonly migrationsDir: string
  readonly logger: MigrateLogger
  readonly abortSignal?: AbortSignal | undefined
  readonly runId?: string | undefined
}

export async function runMigrations(opts: MigrationOptions): Promise<AppliedMigration[]> {
  const { pool, migrationsDir, logger, abortSignal } = opts
  const runId = opts.runId ?? fallbackRunId()
  const runStart = performance.now()
  const appliedSoFar: AppliedMigration[] = []

  const versionRow = await pool.query<{ version: string }>('SELECT version() AS version')
  const pgServerVersion = versionRow.rows[0]?.version
  logger.info(
    { event: 'migrate.start', runId, migrationsDir, pgServerVersion, nodeVersion: process.version },
    'migrate.start',
  )

  const client = await pool.connect()
  let lockStart = 0
  let acquiredLock = false
  // errorPath is set in two places: (1) the inner catch after BEGIN, where
  // pg state has been touched and the error is the wrapped Error with cause;
  // (2) the outer catch, for pre-pg failures (filename validation, readdir
  // ENOENT) where there's nothing to roll back. The finally block branches
  // on it: release(err) destroys the client; release() returns it to pool
  // after DISCARD ALL.
  let errorPath: Error | undefined

  try {
    lockStart = performance.now()
    await acquireAdvisoryLockWithHeartbeat(client, runId, logger, abortSignal)
    acquiredLock = true
    logger.info(
      { event: 'migrate.lock_acquired', runId, waitMs: Math.round(performance.now() - lockStart) },
      'migrate.lock_acquired',
    )

    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )

    const allFiles = (await readdir(migrationsDir)).filter(
      (n) => n.endsWith('.sql') && !n.startsWith('.'),
    )
    for (const f of allFiles) {
      if (!isValidMigrationFilename(f)) {
        throw new Error(
          `invalid migration filename: ${f}. Required grammar: ^[0-9]{3,}_[a-z0-9_]+\\.sql$`,
        )
      }
    }
    const files = allFiles.sort()
    if (files.length === 0) {
      logger.info({ event: 'migrate.no_migrations_found', runId }, 'migrate.no_migrations_found')
      return appliedSoFar
    }

    const appliedRows = await client.query<{ version: string }>('SELECT version FROM _migrations')
    const applied = new Set(appliedRows.rows.map((r) => r.version))
    const pending = files.filter((f) => !applied.has(f))

    // Drift: applied rows without a file on disk. Warn and continue;
    // the checksum-drift follow-up may upgrade this to error.
    const fileSet = new Set(files)
    const missing = [...applied].filter((v) => !fileSet.has(v)).sort()
    if (missing.length > 0) {
      logger.warn(
        {
          event: 'migrate.drift_missing_files',
          runId,
          missing,
          hint: 'applied migrations are missing on disk. If this is the MYT-32→MYT-33 transition, run `pnpm db:reset && pnpm db:migrate`. Otherwise, investigate before continuing — a previously-applied migration was deleted or renamed.',
        },
        'migrate.drift_missing_files',
      )
    }

    // Out-of-order: pending versions lex-less than the highest applied that
    // also exists on disk. Drift rows (applied without a file) are excluded
    // from this baseline — they're already reported by the drift warning and
    // shouldn't gate ordering decisions.
    const appliedOnDisk = [...applied].filter((v) => fileSet.has(v))
    if (appliedOnDisk.length > 0) {
      const maxApplied = appliedOnDisk.sort().at(-1) ?? ''
      const outOfOrder = pending.filter((p) => p < maxApplied)
      if (outOfOrder.length > 0) {
        throw new Error(
          `out-of-order migrations detected: ${outOfOrder.join(', ')} ` +
            `precede already-applied ${maxApplied}. ` +
            `Rebase to a version greater than the highest applied. ` +
            `If you intentionally need to backfill, see spec §12 Recovery.`,
        )
      }
    }

    logger.info(
      {
        event: 'migrate.plan',
        runId,
        pending: pending.length,
        total: files.length,
        pendingVersions: pending,
      },
      'migrate.plan',
    )

    for (const file of pending) {
      if (abortSignal?.aborted) {
        logger.warn(
          {
            event: 'migrate.aborted',
            runId,
            appliedSoFar: appliedSoFar.length,
            remaining: pending.length - appliedSoFar.length,
          },
          'migrate.aborted',
        )
        return appliedSoFar
      }

      const contents = await readFile(join(migrationsDir, file), 'utf8')
      validateNoTransactionStatements(file, contents)

      const start = performance.now()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL statement_timeout = 0')
        await client.query("SET LOCAL lock_timeout = '30s'")
        await client.query("SET LOCAL application_name = 'mythrun-migrate'")
        await client.query(contents)
        await client.query('INSERT INTO _migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (pgErr) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* swallow; reported below */
        }
        const durationMs = Math.round(performance.now() - start)
        logger.error(
          { event: 'migrate.failed', runId, version: file, durationMs, err: pgErr },
          'migrate.failed',
        )
        const err = pgErr instanceof Error ? pgErr : new Error(String(pgErr))
        const wrapped = new Error(`migration ${file} failed: ${err.message}`, { cause: err })
        errorPath = wrapped
        throw wrapped
      }
      const durationMs = Math.round(performance.now() - start)
      logger.info({ event: 'migrate.applied', runId, version: file, durationMs }, 'migrate.applied')
      appliedSoFar.push({ version: file, durationMs })
    }

    return appliedSoFar
  } catch (err) {
    errorPath ??= err instanceof Error ? err : new Error(String(err))
    throw errorPath
  } finally {
    if (acquiredLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()])
        logger.info(
          {
            event: 'migrate.lock_released',
            runId,
            holdMs: Math.round(performance.now() - lockStart),
          },
          'migrate.lock_released',
        )
      } catch (unlockErr) {
        logger.warn(
          { event: 'migrate.unlock_failed', runId, err: unlockErr },
          'migrate.unlock_failed',
        )
      }
    }
    if (errorPath) {
      client.release(errorPath)
    } else {
      try {
        await client.query('DISCARD ALL')
      } catch {
        /* best-effort */
      }
      client.release()
    }
    logger.info(
      {
        event: 'migrate.done',
        runId,
        applied: appliedSoFar.length,
        totalMs: Math.round(performance.now() - runStart),
      },
      'migrate.done',
    )
  }
}

async function acquireAdvisoryLockWithHeartbeat(
  client: PoolClient,
  runId: string,
  logger: MigrateLogger,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const lockArg = LOCK_KEY.toString()
  const tryRes = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
    lockArg,
  ])
  if (tryRes.rows[0]?.ok) return

  const lockStart = performance.now()
  let lastHeartbeatAt = 0
  const heartbeatIntervalMs = 5000
  for (;;) {
    if (abortSignal?.aborted) {
      throw new Error('migrate aborted while waiting for advisory lock')
    }
    const now = performance.now()
    if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
      const holder = await queryHolder(client).catch(() => null)
      logger.info(
        {
          event: 'migrate.lock_waiting',
          runId,
          waitMsSoFar: Math.round(now - lockStart),
          holder,
        },
        'migrate.lock_waiting',
      )
      lastHeartbeatAt = now
    }
    await new Promise((r) => setTimeout(r, 500))
    const again = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      lockArg,
    ])
    if (again.rows[0]?.ok) return
  }
}

interface LockHolder {
  pid: number
  applicationName: string | null
  state: string | null
  queryStartedAt: string | null
  queryPreview: string | null
}

async function queryHolder(client: PoolClient): Promise<LockHolder | null> {
  // pg_locks splits the bigint advisory key across classid (high 32) + objid (low 32),
  // with objsubid = 1 marking int8-style advisory locks. Both classid and objid
  // are `oid` (unsigned 32-bit) — casting the masked bigint to `int` (signed
  // int4) overflows when either half exceeds 2^31. Cast to `oid` instead.
  const sql = `
    SELECT psa.pid, psa.application_name, psa.state,
           psa.query_start, psa.query
      FROM pg_locks pl
      JOIN pg_stat_activity psa ON psa.pid = pl.pid
     WHERE pl.locktype = 'advisory'
       AND pl.classid  = ((($1::bigint >> 32) & x'FFFFFFFF'::bigint)::bigint)::oid
       AND pl.objid    = (($1::bigint & x'FFFFFFFF'::bigint)::bigint)::oid
       AND pl.objsubid = 1
       AND pl.granted  = true
     LIMIT 1
  `
  const res = await client.query<{
    pid: number
    application_name: string | null
    state: string | null
    query_start: Date | null
    query: string | null
  }>(sql, [LOCK_KEY.toString()])
  const row = res.rows[0]
  if (!row) return null
  return {
    pid: row.pid,
    applicationName: row.application_name,
    state: row.state,
    queryStartedAt: row.query_start ? row.query_start.toISOString() : null,
    queryPreview: row.query ? row.query.slice(0, 200) : null,
  }
}

function fallbackRunId(): string {
  // Fallback when caller doesn't supply runId — full uuidv7 is preferred but
  // we don't import the package here so server-boot wiring can pass its own.
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Build a pino err-serializer that:
 *   - wraps pino.stdSerializers.err
 *   - recurses into Error.cause chains
 *   - deletes pg's connectionParameters / connectionString keys at every level
 *   - replaces literal password substrings in message/stack with [REDACTED]
 *
 * Pino's `redact: { paths }` only matches one nesting level per `*`; this
 * serializer is the primary defense against rds_superuser password leakage
 * via pg DatabaseError fields. The CLI block in Task 12 wires it via
 * `serializers: { err: buildErrSerializer(() => env?.databaseUrl) }`.
 *
 * The getter form (rather than passing the URL directly) is so the CLI can
 * pass `() => env?.databaseUrl` and the serializer reads the URL lazily
 * AFTER `loadEnv()` has run — the logger is constructed BEFORE env loads
 * so it can log loadEnv's own failure.
 */
function stripPgConnectionFields(obj: Record<string, unknown>, password: string | undefined): void {
  delete obj.connectionParameters
  delete obj.connectionString
  if (password) {
    const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    if (typeof obj.message === 'string') {
      obj.message = obj.message.replace(re, '[REDACTED]')
    }
    if (typeof obj.stack === 'string') {
      obj.stack = obj.stack.replace(re, '[REDACTED]')
    }
  }
  if (obj.cause && typeof obj.cause === 'object') {
    stripPgConnectionFields(obj.cause as Record<string, unknown>, password)
  }
}

function copyOwnPropsInto(target: Record<string, unknown>, source: object): void {
  const sourceRecord = source as Record<string, unknown>
  for (const key of Object.keys(sourceRecord)) {
    if (!(key in target)) {
      target[key] = sourceRecord[key]
    }
  }
}

// pino.stdSerializers.err flattens cause into message/stack; we structurally
// re-attach it under `cause` so consumers (and our redactor) can recurse.
function serializeWithCause(err: unknown): Record<string, unknown> {
  const base = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>
  if (err && typeof err === 'object' && 'cause' in err) {
    const rawCause: unknown = err.cause
    if (rawCause && typeof rawCause === 'object') {
      const serializedCause = serializeWithCause(rawCause)
      copyOwnPropsInto(serializedCause, rawCause)
      base.cause = serializedCause
    }
  }
  return base
}

export function buildErrSerializer(
  getDatabaseUrl: () => string | undefined,
): (err: unknown) => Record<string, unknown> {
  return (err: unknown): Record<string, unknown> => {
    const base = serializeWithCause(err)
    if (err && typeof err === 'object') copyOwnPropsInto(base, err)
    let password: string | undefined
    try {
      const url = getDatabaseUrl()
      password = url ? new URL(url).password || undefined : undefined
    } catch {
      /* malformed URL — nothing to redact */
    }
    stripPgConnectionFields(base, password)
    return base
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../migrations')

const argv1 = process.argv[1]
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  // env is declared BEFORE the logger so the err serializer's closure
  // can read env?.databaseUrl when it fires.
  let env: ReturnType<typeof loadEnv> | undefined

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { component: 'migrate' },
    serializers: { err: buildErrSerializer(() => env?.databaseUrl) },
    redact: {
      paths: [
        'err.connectionParameters',
        'err.connectionParameters.password',
        'err.connectionString',
        'err.cause.connectionParameters',
        'err.cause.connectionParameters.password',
        'err.cause.connectionString',
      ],
      remove: true,
    },
  })

  const abortController = new AbortController()
  installSignalHandlers(abortController)
  abortController.signal.addEventListener('abort', () => {
    logger.warn({ event: 'migrate.signal_received' }, 'migrate.signal_received')
  })

  try {
    env = loadEnv()
  } catch (err) {
    logger.error(
      { event: 'migrate.fatal', err },
      'migrate.fatal — check DATABASE_URL or backend/.env.development. ' +
        'For local dev: run `pnpm db:up` and copy `.env.development.example` to `.env.development`.',
    )
    process.exitCode = 1
    process.exit()
  }

  const pool = createPgPool(env.databaseUrl, {
    max: 1,
    connectionTimeoutMillis: 10_000,
  })

  const runId = uuidv7()
  try {
    const applied = await runMigrations({
      pool,
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      logger,
      abortSignal: abortController.signal,
      runId,
    })
    logger.info(
      {
        event: applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
        runId,
        count: applied.length,
        versions: applied.map((m) => m.version),
      },
      applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
    )
    if (abortController.signal.aborted) {
      // Aborted-but-graceful: in-flight migration committed. Exit 130
      // by convention — the deploy script keys on this to distinguish
      // "told to stop" from "crashed" (exit 1).
      process.exitCode = 130
    }
  } catch (err) {
    const cause = (err instanceof Error && err.cause) ?? err
    const code = (cause as { code?: string }).code
    let hint: string | undefined
    if (code === '42501') {
      hint =
        'insufficient_privilege. Common causes: (1) migration role lacks rds_superuser for CREATE EXTENSION (see spec §8.4); (2) role lacks USAGE/CREATE on target schema; (3) RLS policy blocks the statement.'
    } else if (code === '28P01') {
      hint =
        'auth failed. Verify MIGRATE_DATABASE_URL / DATABASE_URL credentials match the role secret.'
    } else if (code === '3D000') {
      hint = 'database does not exist. For local dev, run `pnpm db:up`. For RDS, verify the dbname.'
    } else if (code === 'ECONNREFUSED') {
      hint =
        'Postgres unreachable. For local dev, run `pnpm db:up`. For staging/prod, check the security group.'
    } else if (code === 'ENOTFOUND') {
      hint = 'hostname could not be resolved. Verify the DB host in the URL.'
    } else if (code === 'ETIMEDOUT') {
      hint = 'connection timed out (10s). Likely a security group / VPC routing issue.'
    }
    logger.error(
      {
        event: 'migrate.fatal',
        runId,
        err,
        ...(hint && { hint }),
        nextStep: `query CloudWatch with: filter component='migrate' and runId='${runId}'`,
      },
      'migrate.fatal',
    )
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
