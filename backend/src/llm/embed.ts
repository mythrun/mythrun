// backend/src/llm/embed.ts
// MYT-71 §4.1 — the Voyage embeddings wrapper. Plain fetch to /v1/embeddings;
// NO third-party SDK. Asymmetric input types (document for stored rows, query
// for searches), split timeouts (write-path generous, query-path tight),
// bounded 429 backoff, hard length-assert against EMBED_DIM. Config from
// world/retrieval/config.ts — never hardcoded.
import { logger } from './logger.js'
import {
  EMBED_DIM,
  VOYAGE_EMBED_MODEL,
  VOYAGE_OUTPUT_DIMENSION,
  VOYAGE_INPUT_TYPE_DOC,
  VOYAGE_INPUT_TYPE_QUERY,
  VOYAGE_BATCH_MAX_INPUTS,
  VOYAGE_BATCH_MAX_TOKENS,
  VOYAGE_DOC_TIMEOUT_MS,
  VOYAGE_QUERY_TIMEOUT_MS,
  VOYAGE_MAX_RETRIES_429,
} from '../world/retrieval/config.js'

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'

/**
 * Failure-mode taxonomy for the embed wrapper. The split that matters
 * operationally is CONFIG (never self-heals — wrong key, wrong model/params,
 * wrong output dims) vs TRANSIENT (a Voyage outage / network blip that
 * recovers on its own). `isVoyageConfigError` collapses this to that binary.
 */
export type VoyageErrorKind = 'auth' | 'bad_request' | 'rate_limited' | 'dim_mismatch' | 'transient' | 'empty'

/** Typed error for every failure mode of the embed wrapper (HTTP, dim drift, empty data). */
export class VoyageEmbedError extends Error {
  readonly kind: VoyageErrorKind
  readonly status?: number
  constructor(message: string, kind: VoyageErrorKind, status?: number) {
    super(message)
    this.name = 'VoyageEmbedError'
    this.kind = kind
    // Only set under exactOptionalPropertyTypes: assigning undefined to an
    // optional field is a type error; leave it absent when there's no status.
    if (status !== undefined) this.status = status
  }
}

/**
 * Config errors never self-heal (wrong key, wrong model/params, wrong dims) —
 * callers (the boot probe) treat these as fatal; transient ones degrade.
 */
export function isVoyageConfigError(err: unknown): boolean {
  return (
    err instanceof VoyageEmbedError &&
    (err.kind === 'auth' || err.kind === 'bad_request' || err.kind === 'dim_mismatch')
  )
}

export interface VoyageEmbedder {
  embedDocuments(texts: readonly string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

interface EmbedderOpts {
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  readonly sleepImpl?: (ms: number) => Promise<void>
}

interface VoyageResponseBody {
  readonly data: { readonly embedding: number[] }[]
}

/** Rough token estimate: Voyage tokenization averages ~4 chars/token for English prose. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/**
 * Greedy chunker bounded by BOTH the input-count cap (VOYAGE_BATCH_MAX_INPUTS)
 * AND the estimated token cap (VOYAGE_BATCH_MAX_TOKENS). A chunk is flushed
 * when adding the next text would exceed either bound. A single text larger
 * than the token cap occupies a chunk of its own (it cannot be split further
 * here — the API will reject it, which is the intended fail-fast).
 */
export function chunkByCounts(texts: readonly string[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  for (const text of texts) {
    const tokens = estimateTokens(text)
    const wouldExceedCount = current.length >= VOYAGE_BATCH_MAX_INPUTS
    const wouldExceedTokens = current.length > 0 && currentTokens + tokens > VOYAGE_BATCH_MAX_TOKENS
    if (wouldExceedCount || wouldExceedTokens) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(text)
    currentTokens += tokens
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function createVoyageEmbedder(opts: EmbedderOpts): VoyageEmbedder {
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  async function requestOnce(
    input: string[],
    inputType: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return doFetch(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: VOYAGE_EMBED_MODEL,
        input,
        input_type: inputType,
        output_dimension: VOYAGE_OUTPUT_DIMENSION,
      }),
      signal,
    })
  }

  async function call(input: string[], inputType: string, timeoutMs: number): Promise<number[][]> {
    const ac = new AbortController()
    const timer = setTimeout(() => {
      ac.abort()
    }, timeoutMs)
    try {
      for (let attempt = 0; ; attempt++) {
        // The fetch itself can REJECT (network error → TypeError; timeout → the
        // AbortController fires → AbortError). A blip like that is transient by
        // nature — wrap it as a transient VoyageEmbedError so the boot probe can
        // classify it. Only the actual fetch rejection is wrapped here; our own
        // deliberate VoyageEmbedError throws below propagate unchanged.
        let res: Response
        try {
          res = await requestOnce(input, inputType, ac.signal)
        } catch (err) {
          /* c8 ignore start — defense-in-depth: requestOnce is a bare fetch and
             never throws a VoyageEmbedError, so this rethrow arm can't be
             reached today. It guards against a future requestOnce that DOES
             throw our typed error from getting double-wrapped as transient. */
          if (err instanceof VoyageEmbedError) throw err
          /* c8 ignore stop */
          const msg = err instanceof Error ? err.message : String(err)
          throw new VoyageEmbedError(`voyage request failed: ${msg}`, 'transient')
        }
        if (res.status === 429 && attempt < VOYAGE_MAX_RETRIES_429) {
          logger.warn({ attempt }, 'voyage 429; backing off')
          await sleep(2 ** attempt * 500)
          continue
        }
        if (res.status === 429) {
          logger.warn({ status: res.status }, 'voyage 429; retries exhausted')
          throw new VoyageEmbedError('voyage 429 (rate-limited, retries exhausted)', 'rate_limited', 429)
        }
        if (!res.ok) {
          logger.warn({ status: res.status }, 'voyage embed failed')
          if (res.status === 401 || res.status === 403) {
            throw new VoyageEmbedError(`voyage ${String(res.status)} (auth)`, 'auth', res.status)
          }
          if (res.status === 400) {
            throw new VoyageEmbedError(
              'voyage 400 (bad request — wrong model id / output_dimension)',
              'bad_request',
              400,
            )
          }
          throw new VoyageEmbedError(`voyage ${String(res.status)} (transient)`, 'transient', res.status)
        }
        const json = (await res.json()) as VoyageResponseBody
        const vectors = json.data.map((d) => d.embedding)
        for (const v of vectors) {
          if (v.length !== EMBED_DIM) {
            throw new VoyageEmbedError(
              `voyage returned dimension ${String(v.length)}, expected EMBED_DIM ${String(EMBED_DIM)}`,
              'dim_mismatch',
            )
          }
        }
        return vectors
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    embedDocuments: async (texts) => {
      const out: number[][] = []
      for (const chunk of chunkByCounts([...texts])) {
        out.push(...(await call(chunk, VOYAGE_INPUT_TYPE_DOC, VOYAGE_DOC_TIMEOUT_MS)))
      }
      return out
    },
    embedQuery: async (text) => {
      const [v] = await call([text], VOYAGE_INPUT_TYPE_QUERY, VOYAGE_QUERY_TIMEOUT_MS)
      if (v === undefined) throw new VoyageEmbedError('voyage returned no embedding', 'empty')
      return v
    },
  }
}
