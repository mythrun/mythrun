// backend/scripts/world-embed-backfill.ts
//
// MYT-71 Task 9 — operational entry point for the world-retrieval WRITE path.
// Reads a world's un-embedded (or, under --force, all) facts + entities, embeds
// them via Voyage, and writes the vectors back through embedWorld().
//
// Usage:
//   pnpm world:embed-backfill --world <id> [--force]   embed one world
//   pnpm world:embed-backfill --all       [--force]    embed every world
//
// Default selection (no --force) embeds only NULL-embedding rows — the cheap
// incremental backfill, safe to re-run. `--force` re-embeds EVERY fact + entity
// in scope: `--all --force` is a deliberate FULL re-embed of the entire corpus
// and is a real Voyage rate / spend event — run it knowingly, not casually.

import { Pool } from 'pg'
import { loadEnv } from '../src/config/env.js'
import { createRepo } from '../src/repo/index.js'
import { createVoyageEmbedder } from '../src/llm/embed.js'
import { embedWorld } from '../src/world/retrieval/embed-write.js'

interface Args {
  readonly worldId: string | null
  readonly all: boolean
  readonly force: boolean
}

function parseArgs(argv: readonly string[]): Args {
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

async function listWorldIds(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ id: string }>('SELECT id FROM worlds')
  return r.rows.map((row) => row.id)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  try {
    const repo = createRepo(pool)
    const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })

    const worldIds = args.all
      ? await listWorldIds(pool)
      : args.worldId !== null
        ? [args.worldId]
        : []

    log({ msg: 'world-embed-backfill start', worlds: worldIds.length, force: args.force })
    for (const worldId of worldIds) {
      const summary = await embedWorld({ embedder, repo }, worldId, { force: args.force })
      log({ msg: 'world embedded', worldId, ...summary })
    }
    log({ msg: 'world-embed-backfill done', worlds: worldIds.length })
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
