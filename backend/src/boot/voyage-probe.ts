// backend/src/boot/voyage-probe.ts
// Boot-time Voyage validation. Distinct from waitFor() because that crashloops
// on ANY persistent failure — but a transient Voyage outage must NOT crashloop
// the worker (world-gen content still works; embeddings backfill later). So this
// probe splits on isVoyageConfigError: config → throw (crashloop), transient →
// retry a couple times then log LOUD and boot DEGRADED.
import type { VoyageEmbedder } from '../llm/embed.js'
import { isVoyageConfigError } from '../llm/embed.js'

/** Minimal structured logger surface (matches the pino logger the boot seq passes). */
export interface ProbeLogger {
  info: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

const PROBE_TEXT = 'mythrun voyage boot probe'
const TRANSIENT_RETRIES = 2 // total attempts = 3

/**
 * Validate Voyage at boot with one real embedQuery (asserts the live 512-dim
 * round-trip). A CONFIG error (auth/bad_request/dim_mismatch — never self-heals)
 * THROWS, so the process crashloops and the ECS deploy goes red: a misconfigured
 * key can't ship silently. A TRANSIENT failure (5xx/network/timeout) is retried a
 * couple times, then logs LOUD (error level) and RETURNS — the worker boots
 * degraded (world-gen content still works; embeddings backfill once Voyage
 * recovers). Either way the failure is observable, never silent.
 */
export async function probeVoyageAtBoot(embedder: VoyageEmbedder, logger: ProbeLogger): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    try {
      const v = await embedder.embedQuery(PROBE_TEXT)
      logger.info({ event: 'boot.voyage_probe.ok', dim: v.length }, 'voyage reachable; embed dim correct')
      return
    } catch (err) {
      lastErr = err
      if (isVoyageConfigError(err)) {
        logger.error(
          { event: 'boot.voyage_probe.misconfigured', err },
          'VOYAGE_API_KEY misconfigured (auth/bad-request/dim) — refusing to boot',
        )
        throw err
      }
      // transient — fall through to retry
    }
  }
  logger.error(
    { event: 'boot.voyage_probe.unreachable', err: lastErr },
    'voyage unreachable at boot after retries (transient) — booting DEGRADED; embeddings left NULL until Voyage recovers + backfill runs',
  )
}
