// backend/src/world/retrieval/embed-write.ts
//
// MYT-71 Task 9 — the world-retrieval WRITE path (embedWorld). Reads the world's
// un-embedded (or, under force, all) facts + entities via the T6 binder, embeds
// each kind's text through the Voyage wrapper, and writes the vectors back. This
// is the operational backfill's core + the seam consumed by T10 (world-gen embed
// stage) and T11 (character-integration post-pass).
//
// MYT-55 / `reference_transaction_scope_just_writes`: the Voyage round-trip is
// SLOW I/O and must NEVER sit inside a BEGIN — RDS kills idle-in-transaction
// connections at 60s. So for each kind the structure is strictly:
//   1. read the rows-to-embed via the repo (NO tx open),
//   2. embed the whole list with `embedDocuments` (NO tx open),
//   3. write the vectors in a SHORT write-only tx (`repo.transaction`).
//
// Facts and entities are independent passes (separate read → embed → write), so a
// facts-success + entities-Voyage-failure correctly leaves facts embedded and
// entities NULL (partial success is the contract).
//
// ERROR POLICY: ONLY the `embedDocuments` call is wrapped in try/catch. A Voyage
// throw → voyageErrors++, leftNull += rows.length, skip that kind's writes (rows
// stay NULL, retryable next backfill). The write tx is NOT wrapped — a DB write
// error is not a Voyage error; mislabeling it would hide a real failure, so it
// propagates (T10's stage is the catch site).

import type { Repo } from '../../repo/index.js'
import type { VoyageEmbedder } from '../../llm/embed.js'

/** Dependencies for {@link embedWorld}. `embedder` provides the document-path
 *  embedding; `repo` supplies the read binder (`worldRetrieval`) and the short
 *  write tx (`transaction`). Pinned as a Pick so a full `repo` or a hand-built
 *  `{ worldRetrieval, transaction }` both fit. */
export interface EmbedDeps {
  readonly embedder: VoyageEmbedder
  readonly repo: Pick<Repo, 'worldRetrieval' | 'transaction'>
}

/** Options for {@link embedWorld}. `force` re-embeds EVERY row (a full re-embed
 *  = a real Voyage spend event); default (false) embeds only un-embedded rows. */
export interface EmbedWorldOpts {
  readonly force?: boolean
}

/** Outcome of an {@link embedWorld} run. `embedded` rows got a vector; `leftNull`
 *  rows are still un-embedded (skipped after a Voyage failure); `voyageErrors`
 *  counts the kinds whose embed call threw. */
export interface EmbedSummary {
  readonly embedded: number
  readonly leftNull: number
  readonly voyageErrors: number
}

/** Convert a Voyage embedding (number[]) to the pgvector `'[f1,…,fN]'` text
 *  literal the `$::vector` cast expects (pg has no native vector param type).
 *  Local to this file — search.ts has its own copy; they do not share. */
function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`
}

/** Mutable accumulator threaded through the two kind-passes. */
interface EmbedTally {
  embedded: number
  leftNull: number
  voyageErrors: number
}

/**
 * Embed every (or, under `force`, the un-embedded subset of) fact + entity row
 * for `worldId`, writing the vectors back. Returns a per-run tally. See the
 * module header for the strict read→embed→write ordering and error policy.
 */
export async function embedWorld(
  deps: EmbedDeps,
  worldId: string,
  opts?: EmbedWorldOpts,
): Promise<EmbedSummary> {
  const force = opts?.force ?? false
  const tally: EmbedTally = { embedded: 0, leftNull: 0, voyageErrors: 0 }

  // ── FACTS pass ────────────────────────────────────────────────────────────
  // 1. read (no tx)
  const factRows = await deps.repo.worldRetrieval.listFactsToEmbed(worldId, force)
  if (factRows.length > 0) {
    // 2. embed (no tx) — wrap ONLY this slow round-trip.
    let factVecs: number[][] | null = null
    try {
      factVecs = await deps.embedder.embedDocuments(factRows.map((r) => r.content))
    } catch {
      tally.voyageErrors += 1
      tally.leftNull += factRows.length
    }
    if (factVecs !== null) {
      const literals = zipLiterals(factRows, factVecs)
      // 3. write (short tx) — NOT wrapped; a DB error propagates.
      await deps.repo.transaction(async (tx) => {
        for (const { id, literal } of literals) {
          await tx.facts.updateEmbedding(id, literal)
        }
      })
      tally.embedded += factRows.length
    }
  }

  // ── ENTITIES pass ─────────────────────────────────────────────────────────
  // 1. read (no tx)
  const entityRows = await deps.repo.worldRetrieval.listEntitiesToEmbed(worldId, force)
  if (entityRows.length > 0) {
    // 2. embed (no tx) — wrap ONLY this slow round-trip.
    let entityVecs: number[][] | null = null
    try {
      entityVecs = await deps.embedder.embedDocuments(entityRows.map((r) => r.text))
    } catch {
      tally.voyageErrors += 1
      tally.leftNull += entityRows.length
    }
    if (entityVecs !== null) {
      const literals = zipLiterals(entityRows, entityVecs)
      // 3. write (short tx) — NOT wrapped; a DB error propagates.
      await deps.repo.transaction(async (tx) => {
        for (const { id, literal } of literals) {
          await tx.entities.updateEmbedding(id, literal)
        }
      })
      tally.embedded += entityRows.length
    }
  }

  return { embedded: tally.embedded, leftNull: tally.leftNull, voyageErrors: tally.voyageErrors }
}

/**
 * Zip each row's id to its vector's pgvector literal. The embedder returns one
 * vector per input in input order, so `vecs.length === rows.length`; we assert
 * that invariant (a drift means a wrapper bug) so the per-index access narrows
 * without a non-null assertion under noUncheckedIndexedAccess.
 */
function zipLiterals(
  rows: readonly { readonly id: string }[],
  vecs: readonly number[][],
): { id: string; literal: string }[] {
  if (vecs.length !== rows.length) {
    throw new Error(
      `embedWorld: embedder returned ${String(vecs.length)} vectors for ${String(rows.length)} inputs`,
    )
  }
  return rows.map((row, i) => {
    const vec = vecs[i]
    /* c8 ignore start — unreachable after the length-equality guard above:
     * for i < rows.length === vecs.length, vecs[i] is always defined. The
     * branch exists only to narrow `number[] | undefined` (noUncheckedIndexed
     * Access) without a non-null assertion. */
    if (vec === undefined) {
      throw new Error(`embedWorld: missing vector at index ${String(i)}`)
    }
    /* c8 ignore stop */
    return { id: row.id, literal: toVectorLiteral(vec) }
  })
}
