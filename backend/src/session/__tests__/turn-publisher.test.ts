import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionChannel, sessionChannelPattern } from '../../contract/session-channel.js'
import type { ServerFrame } from '../../contract/session-events.js'
import { createTurnPublisher } from '../turn-publisher.js'

// ioredis-mock backs pub/sub from a single in-process broker, so a second
// `new IoRedisMock()` client PSUBSCRIBEs the pattern and receives frames
// published by the publisher's client (verified). `pmessage` fires with
// `(pattern, channel, payload)`. A small delay gives the subscriber a tick to
// receive before we assert.
//
// That single broker is also process-WIDE: every `new IoRedisMock()` shares it,
// and quitting a client does not retract frames already delivered. So a fresh
// per-test KEY_PREFIX scopes each subscriber's pattern to its own test's
// channels — without it, one test's subscriber sees every other test's
// publishes and the counts leak.

const CAMPAIGN = 'c1'
const TURN = 't1'

let keyPrefixCounter = 0

interface CollectedMessage {
  readonly pattern: string
  readonly channel: string
  readonly frame: ServerFrame
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

describe('createTurnPublisher', () => {
  let publisherClient: Redis
  let subscriber: Redis
  let received: CollectedMessage[]
  let KEY_PREFIX: string

  beforeEach(async () => {
    keyPrefixCounter += 1
    KEY_PREFIX = `p${String(keyPrefixCounter)}:`
    publisherClient = new IoRedisMock()
    subscriber = new IoRedisMock()
    received = []
    subscriber.on('pmessage', (pattern: string, channel: string, payload: string) => {
      received.push({ pattern, channel, frame: JSON.parse(payload) as ServerFrame })
    })
    await subscriber.psubscribe(sessionChannelPattern(KEY_PREFIX))
  })

  afterEach(async () => {
    await subscriber.quit()
    await publisherClient.flushall()
    await publisherClient.quit()
  })

  it('dmThinking publishes a dm_thinking frame with turnId on the campaign channel', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.dmThinking(CAMPAIGN, TURN)
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg).toBeDefined()
    expect(msg?.channel).toBe(sessionChannel(KEY_PREFIX, CAMPAIGN))
    expect(msg?.frame).toEqual({ type: 'dm_thinking', turnId: TURN })
  })

  it('textDelta publishes a text_delta frame carrying the text', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.textDelta(CAMPAIGN, TURN, 'a wisp of smoke')
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.channel).toBe(sessionChannel(KEY_PREFIX, CAMPAIGN))
    expect(msg?.frame).toEqual({ type: 'text_delta', turnId: TURN, text: 'a wisp of smoke' })
  })

  it('turnEnd publishes a turn_end frame with turnId', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.turnEnd(CAMPAIGN, TURN)
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.frame).toEqual({ type: 'turn_end', turnId: TURN })
  })

  it('turnError publishes a turn_error frame carrying the message', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.turnError(CAMPAIGN, TURN, 'the weave frayed')
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.frame).toEqual({ type: 'turn_error', turnId: TURN, message: 'the weave frayed' })
  })

  it('emitFor returns a bound TurnEmit that publishes text_delta frames', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    const emit = pub.emitFor(CAMPAIGN, TURN)
    await emit('first')
    await emit('second')
    await tick()

    expect(received).toHaveLength(2)
    expect(received.map((m) => m.frame)).toEqual([
      { type: 'text_delta', turnId: TURN, text: 'first' },
      { type: 'text_delta', turnId: TURN, text: 'second' },
    ])
    expect(received.every((m) => m.channel === sessionChannel(KEY_PREFIX, CAMPAIGN))).toBe(true)
  })

  it('publishes each campaign on its own channel', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.dmThinking('cmp-A', TURN)
    await pub.dmThinking('cmp-B', TURN)
    await tick()

    const channels = received.map((m) => m.channel)
    expect(channels).toContain(sessionChannel(KEY_PREFIX, 'cmp-A'))
    expect(channels).toContain(sessionChannel(KEY_PREFIX, 'cmp-B'))
  })
})
