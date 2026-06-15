// backend/src/boot/__tests__/voyage-probe.test.ts
import { describe, expect, it, vi } from 'vitest'
import { probeVoyageAtBoot, type ProbeLogger } from '../voyage-probe.js'
import { VoyageEmbedError, type VoyageEmbedder } from '../../llm/embed.js'
import { EMBED_DIM } from '../../world/retrieval/config.js'

const vec = (): number[] => Array.from({ length: EMBED_DIM }, () => 0.1)

function makeEmbedder(): { embedQuery: ReturnType<typeof vi.fn>; embedder: VoyageEmbedder } {
  const embedQuery = vi.fn()
  const embedder: VoyageEmbedder = { embedQuery, embedDocuments: vi.fn() }
  return { embedQuery, embedder }
}

function makeLogger(): ProbeLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() }
}

/** Find the first logged call whose payload carries the given `event` tag. */
function loggedEvent(mock: ReturnType<typeof vi.fn>, event: string): boolean {
  return mock.mock.calls.some(([obj]) => (obj as { event?: string }).event === event)
}

describe('probeVoyageAtBoot', () => {
  it('resolves and logs ok when embedQuery returns a 512-dim vector', async () => {
    const { embedQuery, embedder } = makeEmbedder()
    embedQuery.mockResolvedValue(vec())
    const logger = makeLogger()
    await expect(probeVoyageAtBoot(embedder, logger)).resolves.toBeUndefined()
    expect(embedQuery).toHaveBeenCalledTimes(1)
    expect(loggedEvent(logger.info, 'boot.voyage_probe.ok')).toBe(true)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('THROWS on a config error and does not retry (called exactly once)', async () => {
    const { embedQuery, embedder } = makeEmbedder()
    embedQuery.mockRejectedValue(new VoyageEmbedError('401', 'auth', 401))
    const logger = makeLogger()
    await expect(probeVoyageAtBoot(embedder, logger)).rejects.toBeInstanceOf(VoyageEmbedError)
    expect(embedQuery).toHaveBeenCalledTimes(1)
    expect(loggedEvent(logger.error, 'boot.voyage_probe.misconfigured')).toBe(true)
  })

  it('does NOT throw on a persistent transient error; retries then logs unreachable', async () => {
    const { embedQuery, embedder } = makeEmbedder()
    embedQuery.mockRejectedValue(new VoyageEmbedError('500', 'transient', 500))
    const logger = makeLogger()
    await expect(probeVoyageAtBoot(embedder, logger)).resolves.toBeUndefined()
    expect(embedQuery).toHaveBeenCalledTimes(3)
    expect(loggedEvent(logger.error, 'boot.voyage_probe.unreachable')).toBe(true)
  })

  it('recovers after one transient failure then logs ok (called twice)', async () => {
    const { embedQuery, embedder } = makeEmbedder()
    embedQuery
      .mockRejectedValueOnce(new VoyageEmbedError('500', 'transient', 500))
      .mockResolvedValueOnce(vec())
    const logger = makeLogger()
    await expect(probeVoyageAtBoot(embedder, logger)).resolves.toBeUndefined()
    expect(embedQuery).toHaveBeenCalledTimes(2)
    expect(loggedEvent(logger.info, 'boot.voyage_probe.ok')).toBe(true)
    expect(logger.error).not.toHaveBeenCalled()
  })
})
