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

  it('dmCorrection publishes a dm_correction frame carrying turnId + text (no live seq) — myth-d6knq shared contract', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.dmCorrection(CAMPAIGN, TURN, { text: 'Earlier I named the ferryman Coss; it is Trask.' })
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.frame).toEqual({
      type: 'dm_correction',
      turnId: TURN,
      text: 'Earlier I named the ferryman Coss; it is Trask.',
    })
  })

  it('turnReplace publishes ONE session_reconnect frame carrying the rebuilt turn (myth-aiiao whole-turn replace)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    const messages: ServerFrame[] = [
      { type: 'dm_message', seq: 7, turnId: TURN, text: 'The fingers do not yield.' },
      { type: 'dm_message', seq: 8, turnId: TURN, text: 'The vault light holds steady.' },
    ]
    const participants = [{ userId: 'u1', displayName: 'Miklos', characterName: 'Sable' }]
    await pub.turnReplace(CAMPAIGN, messages, participants, 'exploration')
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.channel).toBe(sessionChannel(KEY_PREFIX, CAMPAIGN))
    // The wire frame is the SAME session_reconnect the reconnect path sends —
    // seq-bearing replay messages under one turnId, so the client's transcript
    // reducer whole-turn-replaces and its high-water mark advances normally.
    expect(msg?.frame).toEqual({
      type: 'session_reconnect',
      messages,
      participants,
      mode: 'exploration',
    })
  })

  it('emitFor().emitCorrection publishes the dm_correction frame', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    const emit = pub.emitFor(CAMPAIGN, TURN)
    await emit.emitCorrection({ text: 'Correction: the seal is the Tide Family crest.' })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'dm_correction',
      turnId: TURN,
      text: 'Correction: the seal is the Tide Family crest.',
    })
  })

  it('turnError publishes a turn_error frame carrying the message', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.turnError(CAMPAIGN, TURN, 'the weave frayed')
    await tick()

    expect(received).toHaveLength(1)
    const [msg] = received
    expect(msg?.frame).toEqual({ type: 'turn_error', turnId: TURN, message: 'the weave frayed' })
  })

  it('skillCheck publishes a skill_check frame built field-by-field (no live seq)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.skillCheck(CAMPAIGN, TURN, {
      characterName: 'Mara',
      skill: 'Perception',
      context: 'searching the shelf',
      roll: 14,
      roll2: null,
      rollType: 'normal',
      modifier: 3,
      total: 17,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'You spot the hidden latch.',
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'skill_check',
      turnId: TURN,
      characterName: 'Mara',
      skill: 'Perception',
      context: 'searching the shelf',
      roll: 14,
      roll2: null,
      rollType: 'normal',
      modifier: 3,
      total: 17,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'You spot the hidden latch.',
    })
  })

  it('diceRoll publishes a dice_roll frame carrying the results (no live seq)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.diceRoll(CAMPAIGN, TURN, { count: 2, sides: 6, results: [3, 5], total: 8 })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'dice_roll',
      turnId: TURN,
      count: 2,
      sides: 6,
      results: [3, 5],
      total: 8,
    })
  })

  it('ledgerUpdate publishes a ledger_update frame field-by-field with only the populated optionals (no live seq)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.ledgerUpdate(CAMPAIGN, TURN, {
      characterName: 'Mara',
      kind: 'spell_slot',
      summary: 'Mara casts Detect Magic, spending a level-1 slot.',
      slotLevel: 1,
      slotsRemaining: 1,
    })
    await tick()

    expect(received).toHaveLength(1)
    // Only the populated optionals (slotLevel/slotsRemaining) ride the frame —
    // hp/gold/itemName/etc. are absent, NOT `undefined`.
    expect(received[0]?.frame).toEqual({
      type: 'ledger_update',
      turnId: TURN,
      characterName: 'Mara',
      kind: 'spell_slot',
      summary: 'Mara casts Detect Magic, spending a level-1 slot.',
      slotLevel: 1,
      slotsRemaining: 1,
    })
    // No live seq on the streamed frame (seq rides only the persisted replay).
    expect((received[0]?.frame as { seq?: number }).seq).toBeUndefined()
  })

  it('ledgerUpdate carries restType on a rest frame (the live wind-down signal, myth-lhp99)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.ledgerUpdate(CAMPAIGN, TURN, {
      characterName: 'Mara',
      kind: 'rest',
      summary: 'Mara finishes a long rest.',
      restType: 'long',
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toMatchObject({ type: 'ledger_update', kind: 'rest', restType: 'long' })
  })

  it('ledgerUpdate carries diceRolled when present (an hp adjust rolled dice)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.ledgerUpdate(CAMPAIGN, TURN, {
      characterName: 'Bram',
      kind: 'hp',
      summary: 'Bram takes 7 damage.',
      hp: 11,
      maxHp: 18,
      diceRolled: [3, 4],
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'ledger_update',
      turnId: TURN,
      characterName: 'Bram',
      kind: 'hp',
      summary: 'Bram takes 7 damage.',
      hp: 11,
      maxHp: 18,
      diceRolled: [3, 4],
    })
  })

  it('ledgerUpdate carries every remaining optional (item/feature/condition fields) when set', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.ledgerUpdate(CAMPAIGN, TURN, {
      characterName: 'Lio',
      kind: 'feature',
      summary: 'Lio drinks a healing potion and channels a divine domain use.',
      itemName: 'Healing Potion',
      quantity: 2,
      featureName: 'Channel Divinity',
      usesRemaining: 1,
      condition: 'blessed',
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'ledger_update',
      turnId: TURN,
      characterName: 'Lio',
      kind: 'feature',
      summary: 'Lio drinks a healing potion and channels a divine domain use.',
      itemName: 'Healing Potion',
      quantity: 2,
      featureName: 'Channel Divinity',
      usesRemaining: 1,
      condition: 'blessed',
    })
  })

  it('modeChange publishes a mode_change frame built field-by-field (no live seq)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.modeChange(CAMPAIGN, TURN, { from: 'exploration', to: 'combat', reason: 'combat' })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'mode_change',
      turnId: TURN,
      from: 'exploration',
      to: 'combat',
      reason: 'combat',
    })
    expect((received[0]?.frame as { seq?: number }).seq).toBeUndefined()
  })

  it('combatStarted publishes a combat_started frame carrying enemies + initiative (no live seq)', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.combatStarted(CAMPAIGN, TURN, {
      enemies: [{ name: 'Goblin', description: 'a snarling scout', count: 3 }],
      initiative: [
        { combatant: 'Mara', roll: 18 },
        { combatant: 'Goblin', roll: 7 },
      ],
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'combat_started',
      turnId: TURN,
      enemies: [{ name: 'Goblin', description: 'a snarling scout', count: 3 }],
      initiative: [
        { combatant: 'Mara', roll: 18 },
        { combatant: 'Goblin', roll: 7 },
      ],
    })
    expect((received[0]?.frame as { seq?: number }).seq).toBeUndefined()
  })

  it('combatResolved publishes a combat_resolved frame carrying narration/outcome/casualties/hpChanges', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    await pub.combatResolved(CAMPAIGN, TURN, {
      narration: 'The last goblin flees into the dark.',
      outcome: 'victory',
      casualties: [{ name: 'Goblin', type: 'npc', fate: 'slain' }],
      hpChanges: [{ combatant: 'Mara', hpBefore: 18, hpAfter: 11, maxHp: 18 }],
    })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]?.frame).toEqual({
      type: 'combat_resolved',
      turnId: TURN,
      narration: 'The last goblin flees into the dark.',
      outcome: 'victory',
      casualties: [{ name: 'Goblin', type: 'npc', fate: 'slain' }],
      hpChanges: [{ combatant: 'Mara', hpBefore: 18, hpAfter: 11, maxHp: 18 }],
    })
  })

  it('emitFor returns a bound TurnEmitter whose combat methods publish', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    const emit = pub.emitFor(CAMPAIGN, TURN)
    await emit.emitModeChange({ from: 'exploration', to: 'combat', reason: 'combat' })
    await emit.emitCombatStarted({
      enemies: [{ name: 'Goblin', description: 'a snarling scout', count: 3 }],
      initiative: [{ combatant: 'Mara', roll: 18 }],
    })
    await emit.emitCombatResolved({
      narration: 'The fight ends.',
      outcome: 'victory',
      casualties: [],
      hpChanges: [],
    })
    await tick()

    expect(received).toHaveLength(3)
    expect(received.map((m) => m.frame.type)).toEqual([
      'mode_change',
      'combat_started',
      'combat_resolved',
    ])
    expect(received.every((m) => m.channel === sessionChannel(KEY_PREFIX, CAMPAIGN))).toBe(true)
  })

  it('emitFor returns a bound TurnEmitter that publishes via each method', async () => {
    const pub = createTurnPublisher(publisherClient, KEY_PREFIX)
    const emit = pub.emitFor(CAMPAIGN, TURN)
    await emit.emitText('first')
    await emit.emitText('second')
    await emit.emitDiceRoll({ count: 1, sides: 20, results: [11], total: 11 })
    await emit.emitSkillCheck({
      characterName: 'Bram',
      skill: 'Athletics',
      context: 'vaulting the wall',
      roll: 9,
      roll2: 15,
      rollType: 'advantage',
      modifier: 2,
      total: 17,
      dc: 13,
      outcomeTier: 'success',
      constraint: 'You clear the wall.',
    })
    await emit.emitLedgerUpdate({
      characterName: 'Bram',
      kind: 'gold',
      summary: 'Bram spends 5gp.',
      gold: 42,
    })
    await tick()

    expect(received).toHaveLength(5)
    expect(received.map((m) => m.frame.type)).toEqual([
      'text_delta',
      'text_delta',
      'dice_roll',
      'skill_check',
      'ledger_update',
    ])
    expect(received.slice(0, 2).map((m) => m.frame)).toEqual([
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
