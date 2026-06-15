// backend/src/llm/prep/stages/__tests__/embed-world.test.ts
//
// MYT-71 Task 10. The world-gen embed stage is a TOTAL terminal stage: it
// embeds the freshly-generated world via embedWorld so the world is searchable
// on completion, and NEVER fails the world. It catches ALL embed/Voyage/DB
// errors, logs, and ALWAYS returns { costUsd: 0, inputTokens: 0, outputTokens: 0 }
// (Voyage spend is OFF the Anthropic cost cap). It NEVER rethrows.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { runEmbedWorldStage } from '../embed-world.js'
import * as embedWriteModule from '../../../../world/retrieval/index.js'
import type { Repo } from '../../../../repo/index.js'

vi.mock('../../../../world/retrieval/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../world/retrieval/index.js')>()
  return { ...actual, embedWorld: vi.fn() }
})

// A repo stub is sufficient — the stage only forwards `repo` into embedWorld,
// which is mocked at the module boundary. The Voyage embedder is built inside
// the stage from voyageApiKey but is never invoked (embedWorld is mocked).
function makeRepo(): Repo {
  return {} as unknown as Repo
}

// Capture every pino log line as a parsed object so the test can assert on the
// structured `event` binding the stage emits.
function makeCapturingLogger(): { logger: pino.Logger; logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = []
  const logger = pino(
    { level: 'info' },
    {
      write(line: string): void {
        logs.push(JSON.parse(line) as Record<string, unknown>)
      },
    },
  )
  return { logger, logs }
}

describe('runEmbedWorldStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero-cost on success and logs the embed summary', async () => {
    vi.mocked(embedWriteModule.embedWorld).mockResolvedValueOnce({
      embedded: 12,
      leftNull: 3,
      voyageErrors: 1,
    })

    const { logger, logs } = makeCapturingLogger()

    const repo = makeRepo()
    const result = await runEmbedWorldStage(repo, {
      worldId: 'wld-embed-1',
      voyageApiKey: 'pa-test-key',
      logger,
    })

    expect(result).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 })

    // embedWorld called NULL-only (no force) against the right world.
    expect(embedWriteModule.embedWorld).toHaveBeenCalledTimes(1)
    const call = vi.mocked(embedWriteModule.embedWorld).mock.calls[0]
    expect(call?.[1]).toBe('wld-embed-1')
    // opts omitted → NULL-only embed (the stage never passes force).
    expect(call?.[2]).toBeUndefined()

    const successLog = logs.find((l) => l.event === 'world_gen.embed_world')
    expect(successLog).toBeDefined()
    expect(successLog).toMatchObject({
      event: 'world_gen.embed_world',
      worldId: 'wld-embed-1',
      embedded: 12,
      leftNull: 3,
      voyageErrors: 1,
    })
  })

  it('is TOTAL: catches an embedWorld throw, logs the failure, and still returns zero-cost', async () => {
    vi.mocked(embedWriteModule.embedWorld).mockRejectedValueOnce(
      new Error('pg write blew up'),
    )

    const { logger, logs } = makeCapturingLogger()

    const repo = makeRepo()

    // Must NOT reject.
    const result = await runEmbedWorldStage(repo, {
      worldId: 'wld-embed-2',
      voyageApiKey: 'pa-test-key',
      logger,
    })

    expect(result).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 })

    const failLog = logs.find((l) => l.event === 'world_gen.embed_world_failed')
    expect(failLog).toBeDefined()
    expect(failLog).toMatchObject({
      event: 'world_gen.embed_world_failed',
      worldId: 'wld-embed-2',
    })
  })
})
