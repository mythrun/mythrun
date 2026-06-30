// backend/scripts/world-color-backfill.ts
//
// MYT-87 T9 — operational entry point for the world-colour backfill. Gives
// every EXISTING `complete` world a `WorldColor` dither pair so the campaign
// hub never renders a default/ghost band for an already-generated world (the
// no-silent-stub-fallback guarantee). New worlds get their pair from the T8
// world-gen colour stage; this covers worlds generated before T8 existed.
//
// Usage:
//   pnpm world:color-backfill --world <id>          colour one world
//   pnpm world:color-backfill --all                 colour every uncoloured complete world
//   pnpm world:color-backfill --all --force         RE-colour every complete world
//
// Default `--all` selection (no --force) targets only `status='complete'` worlds
// with a NULL colour pair — the cheap incremental backfill, safe to re-run.
// `--force` widens the selection to EVERY complete world and re-rolls the pair:
// `--all --force` is a deliberate full re-colour of the entire corpus and a real
// Haiku spend event — run it knowingly, not casually. The per-world write
// reuses the canonical T8 stage runner (`runWorldColorStage`), which does the
// generateObject + contrast re-roll + idempotent `worlds.setColorPair` SET.
//
// Mirrors `world-embed-backfill.ts` (parseArgs, loadEnv, Pool, createRepo,
// JSON-line log, top-level catch → exit 1). The `main()` entry is guarded by the
// repo-standard `pathToFileURL` check (cf. worker.ts, migrate.ts) so the unit
// test can import `parseArgs` / `runBackfill` without executing the CLI.

import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { loadEnv } from '../src/config/env.js'
import { createRepo, type Repo } from '../src/repo/index.js'
import { runWorldColorStage } from '../src/llm/prep/stages/world-color.js'

interface Args {
  readonly worldId: string | null
  readonly all: boolean
  readonly force: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  let worldId: string | null = null
  let all = false
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--world') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error('--world requires an id')
      worldId = next
      i++
    } else if (arg === '--all') {
      all = true
    } else if (arg === '--force') {
      force = true
    } else {
      throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  if (worldId === null && !all) {
    throw new Error('provide exactly one of --world <id> or --all')
  }
  if (worldId !== null && all) {
    throw new Error('--world and --all are mutually exclusive')
  }
  return { worldId, all, force }
}

function log(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`)
}

export interface BackfillDeps {
  readonly pool: Pool
  readonly repo: Repo
}

// `--world` targets exactly the named world (the operator's explicit choice).
// `--all` selects every complete world; without --force it skips the already-
// coloured ones (NULL colour_from), the safe incremental default.
async function selectWorldIds(deps: BackfillDeps, args: Args): Promise<string[]> {
  if (args.worldId !== null) return [args.worldId]
  const sql = args.force
    ? `SELECT id FROM worlds WHERE status = 'complete'`
    : `SELECT id FROM worlds WHERE status = 'complete' AND color_from IS NULL`
  const result = await deps.pool.query<{ id: string }>(sql)
  return result.rows.map((row) => row.id)
}

export async function runBackfill(deps: BackfillDeps, args: Args): Promise<void> {
  const worldIds = await selectWorldIds(deps, args)
  log({ msg: 'world-color-backfill start', worlds: worldIds.length, force: args.force })
  for (const worldId of worldIds) {
    const world = await deps.repo.worlds.getById(worldId)
    if (world === null) {
      log({ msg: 'world not found, skipping', worldId })
      continue
    }
    const cost = await runWorldColorStage(deps.repo, {
      worldId: world.id,
      worldName: world.name,
      concept: world.concept,
      tone: world.tone ?? '',
      themes: world.themes ?? '',
    })
    log({ msg: 'world coloured', worldId, ...cost })
  }
  log({ msg: 'world-color-backfill done', worlds: worldIds.length })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  try {
    const repo = createRepo(pool)
    await runBackfill({ pool, repo }, args)
  } finally {
    await pool.end()
  }
}

const argv1 = process.argv[1]
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
