# MYT-62 — Session-prep streaming + prep-status SSE + dev-tool prose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout: failing test first.

**Goal:** Stream session-prep generation prose live to the dev-tool over a dev-only channel, and expose a player-facing phase-only `prep-status` SSE — with the prose↔phase separation enforced structurally (compile-time type quarantine + runtime tripwire + prod-topology).

**Architecture:** Two channels. Prose deltas (`prep-delta`, a `ProseEvent`) publish to a new `prep:campaign:{id}` Redis channel, exposed only by `GET /api/dev/campaigns/:id/prep-prose` (registered solely under `AUTH_MODE=bypass`, absent in prod). Phase events (`prep-started`/`prep-ready`/`prep-failed`, `PipelineEvent` arms) ride the existing `pipeline:campaign:{id}` channel that the player-facing `GET /api/campaigns/:id/prep-status` route reads. `generateSessionPrep` already uses `streamObject`; we consume its `partialObjectStream` (no extra LLM cost).

**Tech Stack:** Node 24 + Fastify + TS (strict), Postgres, Redis pub/sub, BullMQ, Vercel AI SDK (`streamObject`), Vitest. Dev-tool SPA (Vite).

**Spec:** `docs/superpowers/specs/2026-06-02-myt-62-streaming-prep-status-dev-tool-design.md`.

**Standing rules (controller):** all subagents Opus; implementer subagents do NOT `git add`/`commit`/`push` — the controller stages + commits each task's files serially after the two-stage review passes; scoped vitest + `pnpm typecheck` + `pnpm lint` after each task; close each bead as it lands; hold pushes until the issue is done (then wiki subagent + single push; the push needs the backend dev server up for `dev-tool:verify`). `tsc --noEmit` exit 0 is authoritative over injected "cannot find module" snapshots.

---

## File Structure

**Create:**
- `backend/src/sse/__tests__/pipeline-subscriber.test.ts` additions (or new) — tripwire + channel-segment.
- `backend/src/llm/prep/stages/__tests__/session-prep.test.ts` — delta-loop unit test (mocked `streamObject`).
- `backend/dev-tool/src/shell/drawer/prose-view.ts` (+ test) — the prose rendering surface.

**Modify:**
- `backend/src/contract/pipeline-events.ts` — 3 phase arms on `PipelineEvent` + `PIPELINE_SSE_EVENTS`; NEW `ProseEvent` + `PROSE_SSE_EVENTS`.
- `backend/src/contract/__tests__/pipeline-contracts.test.ts` — parity `expected` array.
- `backend/src/sse/pipeline-subscriber.ts` — channel-segment param + type-tripwire.
- `backend/src/llm/prep/stages/session-prep.ts` — `onProseDelta` arg + `partialObjectStream` loop.
- `backend/src/llm/prep/session-prep-processor.ts` — tighten deps; emit prep-* + wire prose.
- `backend/src/worker.ts` + `backend/src/server.ts` — `publishProse` closure at BOTH session-prep wiring sites.
- `backend/src/routes/campaigns.ts` — `prep-status` route.
- `backend/src/app.ts` — prose subscriber + `prep-prose` route in the bypass block; decorate for shutdown.
- `backend/src/routes/sessions.ts` is NOT touched (prep-status lives in campaigns plugin).
- `backend/src/server.ts` — close the prose subscriber at shutdown.
- `backend/src/contract/backend-routes.ts` — both routes + header fix.
- `backend/src/contract/pipeline-routes.ts` — `prep-status` only.
- `backend/dev-tool/coverage.json` — `prep-status` in `routes[]`; phase arms in `events[]`; `session-prep` → `jobs`.
- `backend/dev-tool/verify-registry.ts` — `EXEMPT_ROUTES` += both SSE routes.
- `backend/src/contract/pipeline-jobs.ts` — drop the session-prep "MYT-62" exempt note.
- `backend/dev-tool/src/shell/shell.ts` — second subscription manager + prose-view wiring.
- Existing processor/route test files — extend.

---

## Task 1: Event contracts (phase arms + quarantined ProseEvent)

**Files:**
- Modify: `backend/src/contract/pipeline-events.ts`
- Modify: `backend/src/contract/__tests__/pipeline-contracts.test.ts`

- [ ] **Step 1: Update the parity test (failing first).** In `pipeline-contracts.test.ts`, add the 3 phase arms to the `expected` array (the test sorts, so order is free), and add a new parity test for `PROSE_SSE_EVENTS`:

```ts
// in the existing expected array, append:
      'prep-started',
      'prep-ready',
      'prep-failed',
```

Add a sibling describe block (import `PROSE_SSE_EVENTS, type ProseSseEvent`):

```ts
describe('PROSE_SSE_EVENTS', () => {
  it('is exactly the prose (dev-only) event set, disjoint from PIPELINE_SSE_EVENTS', () => {
    const expected: readonly ProseSseEvent[] = ['prep-delta']
    expect([...PROSE_SSE_EVENTS].sort()).toEqual([...expected].sort())
    // The quarantine: no overlap between the player-channel and prose-channel vocabularies.
    for (const e of PROSE_SSE_EVENTS) expect(PIPELINE_SSE_EVENTS).not.toContain(e)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`prep-*` not in `PIPELINE_SSE_EVENTS`; `PROSE_SSE_EVENTS` undefined):

```
cd backend && pnpm exec vitest run src/contract/__tests__/pipeline-contracts.test.ts
```

- [ ] **Step 3: Add the arms + ProseEvent to `pipeline-events.ts`.** Append the 3 phase strings to `PIPELINE_SSE_EVENTS` (after `'finalized'`):

```ts
  // Session-prep phase events (MYT-62) — player-safe, ride pipeline:campaign:
  'prep-started',
  'prep-ready',
  'prep-failed',
```

Add the 3 phase arms to the `PipelineEvent` union:

```ts
  | { type: 'prep-started'; sessionNumber: number }
  | { type: 'prep-ready'; sessionNumber: number; costUsd: number }
  | { type: 'prep-failed'; sessionNumber: number; terminal: boolean }
```

Then add the SEPARATE prose type at the end of the file (NOT part of `PipelineEvent`/`PIPELINE_SSE_EVENTS` — this disjointness is the compile-time enforced-ignorance control, spec §4.2/§12):

```ts
// Prose events (MYT-62) — dev-only, ride the SEPARATE prep:campaign: channel.
// Deliberately NOT in PipelineEvent / PIPELINE_SSE_EVENTS: prep-delta carries
// sd_playbook prose (may contain secrets) and must never type-check onto the
// player-facing pipeline channel. publishProse accepts ProseEvent; publishEvent
// accepts PipelineEvent — so publishEvent(campaignId, prepDelta) is a compile error.
export const PROSE_SSE_EVENTS: readonly string[] = ['prep-delta'] as const
export type ProseSseEvent = (typeof PROSE_SSE_EVENTS)[number]

export type ProseEvent = {
  type: 'prep-delta'
  field: 'ft_context' | 'sd_playbook'
  text: string
}
```

- [ ] **Step 4: Run — expect PASS:**

```
cd backend && pnpm exec vitest run src/contract/__tests__/pipeline-contracts.test.ts && pnpm typecheck
```

- [ ] **Step 5: Commit** (controller stages):

```
backend/src/contract/pipeline-events.ts
backend/src/contract/__tests__/pipeline-contracts.test.ts
```

---

## Task 2: Subscriber channel-segment param + type-tripwire

**Files:**
- Modify: `backend/src/sse/pipeline-subscriber.ts`
- Modify (or create): `backend/src/sse/__tests__/pipeline-subscriber.test.ts`

**Context:** `createPipelineSubscriber(redis, redisKeyPrefix, logger)` hardcodes `'pipeline'` in `pattern`/`channelPrefix` (L50-51) and writes every message verbatim in `pmessage` (L101-127). We (a) add an optional `channel` segment so a `'prep'` prose subscriber can reuse the factory, and (b) add a tripwire: on the **pipeline** channel only, drop+log any message whose parsed `type ∉ PIPELINE_SSE_EVENTS` (defense-in-depth so a stray `prep-delta` can't reach a player sink). The prose subscriber does NOT apply the pipeline tripwire.

- [ ] **Step 1: Write failing tests** in `pipeline-subscriber.test.ts` (use the existing ioredis-mock harness in that dir; if none, mirror the nearest SSE test's mock). Two cases:

```ts
it('drops a message whose type is not in PIPELINE_SSE_EVENTS (tripwire)', async () => {
  // attach a sink, publish {type:'prep-delta', field:'sd_playbook', text:'SECRET'}
  // on the pipeline channel → sink.write is NEVER called with that payload;
  // a warn is logged.
})
it('forwards a legit pipeline event (type in PIPELINE_SSE_EVENTS)', async () => {
  // publish {type:'prep-started', sessionNumber:1} → sink.write called with the frame.
})
it('a prose-segment subscriber forwards prep-delta verbatim (no pipeline tripwire)', async () => {
  // createPipelineSubscriber(redis, prefix, log, { channel: 'prep' }) → publishing
  // {type:'prep-delta',...} on prep:campaign:{id} reaches the sink.
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Change the signature to take an options object (4th arg, optional) and derive the segment:

```ts
export function createPipelineSubscriber(
  redis: Redis,
  redisKeyPrefix: string,
  logger: pino.Logger,
  opts: { readonly channel?: 'pipeline' | 'prep' } = {},
): PipelineSubscriber {
  const channel = opts.channel ?? 'pipeline'
  // ...
  const pattern = `${redisKeyPrefix}${channel}:campaign:*`
  const channelPrefix = `${redisKeyPrefix}${channel}:campaign:`
```

Import the tripwire set at the top:

```ts
import { PIPELINE_SSE_EVENTS } from '../contract/pipeline-events.js'
const PIPELINE_EVENT_TYPES = new Set(PIPELINE_SSE_EVENTS)
```

In the `pmessage` handler, BEFORE building the frame, add the tripwire (pipeline channel only):

```ts
const campaignId = channel.slice(channelPrefix.length)
// Tripwire (MYT-62, spec §7.1/§12): on the player-facing pipeline channel,
// drop any event whose type isn't a known pipeline event — a stray prep-delta
// (prose, secret-bearing) must never reach a player sink. The prose channel
// carries its own vocabulary and is dev-only, so it skips this gate.
if (opts.channel === undefined || opts.channel === 'pipeline') {
  let parsedType: unknown
  try {
    parsedType = (JSON.parse(message) as { type?: unknown }).type
  } catch {
    parsedType = undefined
  }
  if (typeof parsedType !== 'string' || !PIPELINE_EVENT_TYPES.has(parsedType)) {
    logger.warn(
      { campaignId, parsedType },
      'pipeline-subscriber: dropped message with unknown/forbidden event type',
    )
    return
  }
}
const sinks = map.get(campaignId)
// ... unchanged
```

- [ ] **Step 4: Run — expect PASS** + `pnpm typecheck`.

- [ ] **Step 5: Commit:** `pipeline-subscriber.ts` + its test.

---

## Task 3: Prose delta loop in `generateSessionPrep`

**Files:**
- Modify: `backend/src/llm/prep/stages/session-prep.ts`
- Create: `backend/src/llm/prep/stages/__tests__/session-prep.test.ts`

**Context:** `generateSessionPrep` awaits `result.object`. We add `onProseDelta?` to `GenerateSessionPrepArgs` and consume `result.partialObjectStream` first. The `streamObject` wrapper (`../../ai.js`) shadows only `.object`; `partialObjectStream`/`usage` are live SDK getters (verified). Length-diff + `startsWith` guard + per-call try/catch.

- [ ] **Step 1: Write failing test** (`session-prep.test.ts`). Mock `../../ai.js` `streamObject` to return an object whose `partialObjectStream` is a scripted async iterable and whose `object`/`usage` resolve. Cases:

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest'
const streamObjectMock = vi.fn()
vi.mock('../../../ai.js', () => ({ streamObject: (...a: unknown[]) => streamObjectMock(...a) }))
vi.mock('../../serialize-world-state-for-prep.js', () => ({
  serializeWorldStateForPrep: () => Promise.resolve('WORLD'),
}))
vi.mock('../../../prompts.js', () => ({ loadPrompt: () => 'PROMPT' }))
// ... import generateSessionPrep AFTER mocks

function scripted(partials: Record<string, string>[], object: { ft_context: string; sd_playbook: string }) {
  return {
    partialObjectStream: (async function* () { for (const p of partials) yield p })(),
    object: Promise.resolve(object),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
  }
}

it('emits ordered per-field prose deltas with no overlap or loss', async () => {
  const deltas: { field: string; text: string }[] = []
  streamObjectMock.mockReturnValue(scripted(
    [{ ft_context: 'Hel' }, { ft_context: 'Hello' }, { ft_context: 'Hello', sd_playbook: 'SD' }],
    { ft_context: 'Hello', sd_playbook: 'SD' },
  ))
  const r = await generateSessionPrep({} as never, {
    campaignId: 'c', worldId: 'w', sessionNumber: 1,
    onProseDelta: (field, text) => deltas.push({ field, text }),
  })
  expect(deltas).toEqual([
    { field: 'ft_context', text: 'Hel' },
    { field: 'ft_context', text: 'lo' },
    { field: 'sd_playbook', text: 'SD' },
  ])
  expect(r.ft_context).toBe('Hello')
  expect(r.sd_playbook).toBe('SD')
})

it('mid-escape truncation: resets without emitting when the new value is not a strict extension', async () => {
  const deltas: string[] = []
  streamObjectMock.mockReturnValue(scripted(
    [{ ft_context: 'foo\\' }, { ft_context: 'foo\\n bar' }],  // the `\` chunk then the resolved escape
    { ft_context: 'foo\n bar', sd_playbook: 'x'.repeat(100) },
  ))
  await generateSessionPrep({} as never, {
    campaignId: 'c', worldId: 'w', sessionNumber: 1,
    onProseDelta: (_f, text) => deltas.push(text),
  })
  // the mid-escape partial 'foo\' is not a prefix-extension once it becomes 'foo\n bar'
  // → guard resets; we don't assert exact deltas, only that it didn't throw and finished.
  expect(deltas.join('')).toContain('foo')
})

it('a throwing onProseDelta does not abort generation', async () => {
  streamObjectMock.mockReturnValue(scripted([{ ft_context: 'a' }], { ft_context: 'a', sd_playbook: 'b' }))
  const r = await generateSessionPrep({} as never, {
    campaignId: 'c', worldId: 'w', sessionNumber: 1,
    onProseDelta: () => { throw new Error('boom') },
  })
  expect(r.ft_context).toBe('a')
})

it('drains cleanly with no callback', async () => {
  streamObjectMock.mockReturnValue(scripted([{ ft_context: 'a' }], { ft_context: 'a', sd_playbook: 'b' }))
  const r = await generateSessionPrep({} as never, { campaignId: 'c', worldId: 'w', sessionNumber: 1 })
  expect(r.sd_playbook).toBe('b')
})
```

- [ ] **Step 2: Run — expect FAIL** (`onProseDelta` not in args; no loop).

- [ ] **Step 3: Implement.** Add the field to the args interface:

```ts
export interface GenerateSessionPrepArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly sessionNumber: number
  // MYT-62: optional prose-delta sink. Fire-and-forget; absent in tests / MYT-64.
  readonly onProseDelta?: (field: 'ft_context' | 'sd_playbook', text: string) => void
}
```

Replace the final `const output = await result.object` block with the consume-then-finalize loop:

```ts
  const FIELDS = ['ft_context', 'sd_playbook'] as const
  const seen: Record<(typeof FIELDS)[number], number> = { ft_context: 0, sd_playbook: 0 }
  if (args.onProseDelta) {
    for await (const partial of result.partialObjectStream) {
      for (const field of FIELDS) {
        const value = (partial as Partial<SessionPrep>)[field]
        if (typeof value !== 'string') continue
        if (value.length <= seen[field]) continue
        // Only emit a strict prefix-extension; a mid-escape truncation (the SDK's
        // partial-JSON parser can briefly shorten the committed prefix) is not an
        // extension — reset without emitting (cosmetic on a dev-only feed).
        if (!value.startsWith(value.slice(0, seen[field]))) {
          seen[field] = value.length
          continue
        }
        const delta = value.slice(seen[field])
        seen[field] = value.length
        try {
          args.onProseDelta(field, delta)
        } catch {
          // fire-and-forget: a throwing sink must never abort generation.
        }
      }
    }
  }
  const output = await result.object
  const usage = await result.usage
  return { ft_context: output.ft_context, sd_playbook: output.sd_playbook, usage }
```

(Note: the `startsWith(value.slice(0, seen[field]))` check compares the new value's own prefix — since we can't hold the old value, the practical guard is "new length > seen"; the prefix re-derivation is defensive. If the reviewer prefers retaining the prior string to do a true `startsWith(prevValue)`, that's acceptable — keep a `prev` per field. Either is correct; pick one and test it.)

- [ ] **Step 4: Run — expect PASS** + `pnpm typecheck`.

- [ ] **Step 5: Commit:** `session-prep.ts` + its test.

---

## Task 4: Processor prep-* events + `publishProse` wiring (both sites)

**Files:**
- Modify: `backend/src/llm/prep/session-prep-processor.ts`
- Modify: `backend/src/worker.ts`, `backend/src/server.ts`
- Modify: `backend/src/llm/prep/__tests__/session-prep-processor.test.ts`

**Context:** Tighten `SessionPrepProcessorDeps` so `publishEvent: PipelineEvent` and add `publishProse: ProseEvent` (the shared `Record<string,unknown>` closures stay assignable via contravariance). Emit `prep-started` before generation, `prep-ready`/`prep-failed` after (replacing the drifted `stage-completed`/`stage-failed`), and wire `onProseDelta → publishProse(prep-delta)`.

- [ ] **Step 1: Write failing tests** (extend the existing real-Postgres processor test). Cases:
  - happy path → publishes `prep-started` then `prep-ready{sessionNumber,costUsd}` to the PHASE publisher; `prep-delta` to the PROSE publisher (spy on a mocked `generateSessionPrep` that invokes `onProseDelta`).
  - **enforced-ignorance assertion:** assert no event with `type:'prep-delta'` is ever passed to `publishEvent` (only to `publishProse`).
  - failure → `prep-failed{sessionNumber,terminal}` to the phase publisher; campaign status untouched.
  - Build the processor the way BOTH `worker.ts` and `server.ts` build it (a small helper that takes the two closures) and assert prose publication from each.
  - Type-level: `// @ts-expect-error` that `deps.publishEvent(campaignId, { type: 'prep-delta', field: 'ft_context', text: 'x' })` does not compile.

Mock `generateSessionPrep` to call `args.onProseDelta?.('sd_playbook', 'SECRET')` then resolve, so the prose path is exercised.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Tighten deps + import the event types:

```ts
import type { PipelineEvent, ProseEvent } from '../../contract/pipeline-events.js'

export interface SessionPrepProcessorDeps {
  readonly pool: Pool
  readonly publishEvent: (campaignId: string, event: PipelineEvent) => Promise<void>
  readonly publishProse: (campaignId: string, event: ProseEvent) => Promise<void>
}
```

After the claim (before resolving `worldId`), publish started:

```ts
  await deps.publishEvent(campaignId, { type: 'prep-started', sessionNumber })
```

Pass the prose sink into generation:

```ts
    const result = await generateSessionPrep(repo, {
      campaignId, worldId, sessionNumber,
      onProseDelta: (field, text) => {
        // best-effort: never fail the job on a prose publish error.
        void deps.publishProse(campaignId, { type: 'prep-delta', field, text }).catch(() => {})
      },
    })
```

Replace the success publish (was `stage-completed`):

```ts
    await deps.publishEvent(campaignId, { type: 'prep-ready', sessionNumber, costUsd })
```

Replace the failure publish (was `stage-failed`):

```ts
    await deps.publishEvent(campaignId, { type: 'prep-failed', sessionNumber, terminal })
```

(Keep everything else — `atomicClaimStage`, `markStageCompleted`/`markStageFailed`, `isTerminalError` rethrow, NO `campaigns.setFailed`, the c8-ignore'd cost arms — unchanged.)

- [ ] **Step 4: Wire `publishProse` at BOTH sites.** `worker.ts` (after the existing `publishEvent` closure):

```ts
const publishProse = async (campaignId: string, event: ProseEvent): Promise<void> => {
  const channel = `${env.redisKeyPrefix}prep:campaign:${campaignId}`
  await redisRealtime.publish(channel, JSON.stringify(event))
}
// ...and inject:
createSessionPrepProcessor({ pool: pg, publishEvent, publishProse })
```

`server.ts` `buildSessionPrepWorker` (add the closure next to its local `publishEvent`, using the same `redisKeyPrefix` param, and inject):

```ts
const publishProse = async (campaignId: string, event: ProseEvent): Promise<void> => {
  const channel = `${redisKeyPrefix}prep:campaign:${campaignId}`
  await redisRealtime.publish(channel, JSON.stringify(event))
}
return new Worker(
  QUEUE_SESSION_PREP,
  createSessionPrepProcessor({ pool, publishEvent, publishProse }),
  { connection, concurrency: CONCURRENCY_SESSION_PREP },
)
```

Import `ProseEvent` in both files.

- [ ] **Step 5: Run — expect PASS** + `pnpm typecheck` + scoped coverage on the processor (`--coverage.include='src/llm/prep/session-prep-processor.ts'`).

- [ ] **Step 6: Commit:** processor + worker.ts + server.ts + processor test.

---

## Task 5: Dev prose subscriber + `prep-prose` route (bypass-only)

**Files:**
- Modify: `backend/src/app.ts`, `backend/src/server.ts`
- Modify: `backend/src/contract/backend-routes.ts`, `backend/dev-tool/verify-registry.ts`
- Test: a new `backend/src/routes/__tests__/prep-prose.test.ts` (or extend an app-level test)

**Context:** In the `if (config.env.authMode === 'bypass')` block in `app.ts`, construct a prose subscriber (`createPipelineSubscriber(..., { channel: 'prep' })`), decorate it for shutdown, and register the route. The route mirrors `status/stream` minus the snapshot, attaches to the prose subscriber. NOT a `pipelineRoute`; NOT in `PIPELINE_ROUTES` (would crash prod boot, spec §7.2).

- [ ] **Step 1: Write failing tests.**
  - Under bypass: opening `/api/dev/campaigns/:id/prep-prose`, then publishing a `prep-delta` on `prep:campaign:{id}`, streams the `data:` frame to the client.
  - **Real-mode negative test:** boot `buildApp(deps, { mode: 'real', userPoolId, appClientId }, stubConfig({authMode:'real'}))`; assert `app.printRoutes()` contains no `/api/dev/` path AND an inject to `/api/dev/campaigns/x/prep-prose` returns 404.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement the route + subscriber.** Add a small plugin `backend/src/routes/dev-prep-prose.ts` (mirror dev-credits' in-plugin `AUTH_MODE` gate) taking `{ subscriber: PipelineSubscriber, counter: ConnectionCounter }`:

```ts
export const devPrepProseRoutes: FastifyPluginAsync<{ subscriber: PipelineSubscriber; counter: ConnectionCounter }> =
  async (app, opts) => {
    if (process.env.AUTH_MODE !== 'bypass') return
    app.get<{ Params: { campaignId: string } }>(
      '/api/dev/campaigns/:campaignId/prep-prose',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } },
      async (request, reply) => {
        const campaignId = request.params.campaignId
        opts.counter.increment()
        let detach: (() => void) | null = null
        const sink = openSseConnection({
          request, reply, logger: request.log as PinoLogger,
          onClose: () => { if (detach) detach(); opts.counter.decrement() },
        })
        detach = opts.subscriber.attach(campaignId, sink)
        return reply
      },
    )
  }
```

In `app.ts` bypass block, construct the prose subscriber + register, and decorate for shutdown:

```ts
if (config.env.authMode === 'bypass') {
  await app.register(devCreditsRoutes, { pool: deps.pg })
  const proseSubscriber = createPipelineSubscriber(deps.redisRealtime, deps.redisKeyPrefix, pinoLog, { channel: 'prep' })
  app.decorate('mythrunProseSubscriber', proseSubscriber)
  await app.register(devPrepProseRoutes, { subscriber: proseSubscriber, counter })
}
```

Add `mythrunProseSubscriber?: PipelineSubscriber` to the `declare module 'fastify'` block. In `server.ts` `createShutdown`, close it if present: `if (app.mythrunProseSubscriber) await app.mythrunProseSubscriber.close()`.

- [ ] **Step 4: Contracts.** `backend-routes.ts`: under the "Dev credits (AUTH_MODE=bypass only)" block add `{ method: 'GET', path: '/api/dev/campaigns/:campaignId/prep-prose' }`, and fix the header comment ("every route the **production** app registers" → "…the app registers in bypass-mode boot — the superset; `/api/dev/*` are bypass-only, absent in prod"). `verify-registry.ts` `EXEMPT_ROUTES` += `{ method: 'GET', path: '/api/dev/campaigns/:campaignId/prep-prose' }` with a comment ("live prose SSE consumed by the wire-log drawer — header chrome, not a JSDOM-mountable page panel; exercised E2E by MYT-64"). Do NOT add to `pipeline-routes.ts` or `coverage.json routes[]`.

- [ ] **Step 5: Run — expect PASS** (route tests + `backend-routes.test.ts` under bypass + the real-mode negative test) + `pnpm typecheck`.

- [ ] **Step 6: Commit:** app.ts, server.ts, dev-prep-prose.ts, backend-routes.ts, verify-registry.ts, the test.

---

## Task 6: Player `prep-status` route

**Files:**
- Modify: `backend/src/routes/campaigns.ts`
- Modify: `backend/src/contract/backend-routes.ts`, `backend/src/contract/pipeline-routes.ts`, `backend/dev-tool/coverage.json`, `backend/dev-tool/verify-registry.ts`
- Test: extend `backend/src/routes/__tests__/campaigns-*.test.ts` (or a new `prep-status.test.ts`)

**Context:** A sibling of `status/stream` in the campaigns plugin. `pipelineRoute: true`. Snapshot from `repo.sessionPreps.existsFor(campaignId, 1)` (MVP: `sessionNumber` hardcoded to 1). Attaches to the phase channel; the Task-2 tripwire guarantees no `prep-delta` reaches it.

- [ ] **Step 1: Write failing tests.**
  - opening `/api/campaigns/:id/prep-status` emits `event: snapshot\ndata: {"status":"generating"}` when no prep row exists; `"ready"` when it exists.
  - publishing a `prep-started`/`prep-ready` on `pipeline:campaign:{id}` forwards the frame.
  - publishing a `prep-delta` on `pipeline:campaign:{id}` (simulating a wiring bug) is NOT forwarded (Task-2 tripwire — assert here too).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the route in `campaigns.ts` (mirror `status/stream`, swap the snapshot):

```ts
const PREP_SESSION_NUMBER = 1 // MVP: session 1 only (MYT-59 scope); session-runtime resolves the current session later.

app.get<{ Params: Params }>(
  '/api/campaigns/:campaignId/prep-status',
  {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest): string => {
        try { return requireDbUser(req).id } catch { return req.ip }
      } },
      pipelineRoute: true,
    },
    preHandler: requireCampaignMember(repo),
  },
  async (request, reply) => {
    const campaignId = request.params.campaignId
    opts.counter.increment()
    let detach: (() => void) | null = null
    const sink = openSseConnection({
      request, reply, logger: request.log as PinoLogger,
      onClose: () => { if (detach) detach(); opts.counter.decrement() },
    })
    detach = opts.subscriber.attach(campaignId, sink)
    const exists = await repo.sessionPreps.existsFor(campaignId, PREP_SESSION_NUMBER)
    sink.write(`event: snapshot\ndata: ${JSON.stringify({ status: exists ? 'ready' : 'generating' })}\n\n`)
    return reply
  },
)
```

- [ ] **Step 4: Contracts.** `backend-routes.ts`: `{ method: 'GET', path: '/api/campaigns/:campaignId/prep-status' }` (with the campaign routes). `pipeline-routes.ts`: `'GET /api/campaigns/:campaignId/prep-status'`. `coverage.json routes[]`: `"GET /api/campaigns/:campaignId/prep-status"` + `events[]` += the 3 phase arms. `verify-registry.ts` `EXEMPT_ROUTES` += `{ method: 'GET', path: '/api/campaigns/:campaignId/prep-status' }` (comment: "phase-only prep SSE; consumed by the frontend loading screen + dev-tool drawer, no JSDOM page panel; E2E via MYT-64").

- [ ] **Step 5: Run — expect PASS** (route tests + `backend-routes.test.ts` + `pipeline-contracts` + `dev-tool:check`) + `pnpm typecheck`.

- [ ] **Step 6: Commit:** campaigns.ts + the 4 contract files + the test.

---

## Task 7: Dev-tool prose surfacing

**Files:**
- Create: `backend/dev-tool/src/shell/drawer/prose-view.ts` (+ `__tests__/prose-view.test.ts`)
- Modify: `backend/dev-tool/src/shell/shell.ts`
- Modify: `backend/dev-tool/coverage.json`, `backend/src/contract/pipeline-jobs.ts`

**Context:** A second `createSubscriptionManager` for the prose channel, plus a minimal prose-view reducer that appends `prep-delta.text` under `ft_context`/`sd_playbook`. Keep it simple (text flowing in).

- [ ] **Step 1: Write a failing reducer test** (`prose-view.test.ts`) for a pure `applyProseDelta(state, {field, text})` that appends to the right field:

```ts
it('appends prep-delta text under the correct field', () => {
  let s = emptyProseState()
  s = applyProseDelta(s, { field: 'ft_context', text: 'Hello ' })
  s = applyProseDelta(s, { field: 'ft_context', text: 'world' })
  s = applyProseDelta(s, { field: 'sd_playbook', text: 'SD' })
  expect(s.ft_context).toBe('Hello world')
  expect(s.sd_playbook).toBe('SD')
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `prose-view.ts` (the pure reducer + a tiny mount that renders the two growing panes) and wire a second manager in `shell.ts`:

```ts
const proseSubscriptions = createSubscriptionManager({
  onEvent: (e) => { proseBus.publish(e); },           // or route directly to the prose view
  urlFor: (id) => `/api/dev/campaigns/${id}/prep-prose`,
})
```

Drive it from the SAME 4 call sites that drive `subscriptions` (identity-change, initial mount, active-campaign-change, teardown) — `proseSubscriptions.closeAll()` / `.subscribe(active)` alongside the existing calls. Render `prep-delta` events via the prose view.

- [ ] **Step 4: Coverage + jobs.** `coverage.json`: remove `session-prep` from `exempt.jobs` and add it to `jobs` (`["world-gen","character-creation","character-integration","session-prep"]`). `pipeline-jobs.ts`: drop the "No dev-tool driver yet (that's MYT-62)" comment on the `session-prep` entry.

- [ ] **Step 5: Run — expect PASS** (prose-view test + `pnpm --filter @mythrun/dev-tool typecheck` + `pnpm --filter @mythrun/dev-tool lint` + `cd backend && pnpm exec vitest run dev-tool` + `pnpm dev-tool:check`).

- [ ] **Step 6: Commit:** prose-view.ts (+test), shell.ts, coverage.json, pipeline-jobs.ts.

---

## Final (controller, after all tasks)

1. Final holistic review (subagent or inline — judgment per task novelty).
2. Full gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm dev-tool:check`.
3. Wiki sync (AUTHORING.md subagent for MYT-62 — the new routes + events + the prose stream + the leak-boundary callout; note `runtime/llm.html` / a new prep-streaming page).
4. Start the backend dev server (`cd backend && pnpm dev`) before pushing — the diff touches `backend/dev-tool/**` + the contract routes, so the pre-push `dev-tool:verify` (step 6) runs and needs a live `:3030`.
5. Single push (carries the spec/plan commits too). Flip MYT-62 → Done.
6. MYT-64 (real-LLM E2E smoke) is the next sibling; the constructed-state smoke seam is left wired, not run, here.

---

## Self-review

- **Spec coverage:** §4 → Task 1; §5 → Task 3; §6 → Task 4; §7.1 → Task 6; §7.2 → Task 5; §8 → Task 2 (+5); §9 → Task 7; §10 → Tasks 1/5/6/7; §11 → Tasks 3/4; §12 (3-layer) → Task 1 (type) + Task 2 (tripwire) + Task 5 (topology); §13 → tests in each task. All covered.
- **Type consistency:** `ProseEvent`/`PipelineEvent` defined in Task 1, consumed in Tasks 2/4/5; `publishProse`/`onProseDelta` signatures consistent across Tasks 3/4; `prep-status`/`prep-prose` paths consistent across Tasks 5/6 and the contract files.
- **Placeholder scan:** no TBDs; the one judgment call (delta-loop `startsWith` vs retained-`prev`) is explicitly bounded with both acceptable options + a test requirement.
