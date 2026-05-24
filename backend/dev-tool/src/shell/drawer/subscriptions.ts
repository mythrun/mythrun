// backend/dev-tool/src/shell/drawer/subscriptions.ts
//
// myth-mbdc: EventSource lifecycle manager. One EventSource per
// subscribed campaign; the drawer owns these; long-running panels
// subscribe to the bus instead of opening their own.

export interface DrawerEvent {
  readonly campaignId: string
  readonly type: string
  readonly data: Record<string, unknown>
  readonly receivedAt: number
}

export interface SubscriptionManagerOpts {
  readonly onEvent: (event: DrawerEvent) => void
  readonly urlFor: (campaignId: string) => string
}

export interface SubscriptionManager {
  subscribe(campaignId: string): void
  unsubscribe(campaignId: string): void
  list(): readonly string[]
  closeAll(): void
}

export function createSubscriptionManager(opts: SubscriptionManagerOpts): SubscriptionManager {
  const open = new Map<string, EventSource>()

  function close(campaignId: string): void {
    const es = open.get(campaignId)
    if (es !== undefined) {
      es.close()
      open.delete(campaignId)
    }
  }

  // myth-wirelog: the backend SSE emits BOTH unnamed `data:` frames
  // (each with a `{type, ...}` JSON body) AND named frames with an
  // `event:` line (initial `snapshot`, `phase` updates, the
  // server-side `close` ping). EventSource.onmessage fires ONLY for
  // unnamed frames; named events need an explicit addEventListener.
  // Subscribe to both so the wire log captures everything the backend
  // sends — pre-this-fix the user saw 0 events in the drawer even
  // though stage-completed / entity-added were arriving, because the
  // initial snapshot was named and the drawer's "first-touch" never
  // happened until an unnamed event arrived (often many seconds in).
  const NAMED_EVENTS = [
    'snapshot',
    'phase',
    'stage-started',
    'stage-completed',
    'stage-failed',
    'cost-update',
    'entity-added',
    'entity-updated',
    'entity-removed',
    'edge-added',
    'edge-removed',
    'job-failed',
    'stage-reset',
    'finalized',
    'close',
  ] as const

  function handleFrame(campaignId: string, eventName: string, data: string): void {
    let raw: { type?: unknown; data?: unknown } & Record<string, unknown>
    try {
      raw = JSON.parse(data) as { type?: unknown; data?: unknown } & Record<string, unknown>
    } catch {
      return
    }
    // Frame-name precedence rules:
    //   1. Unnamed `data:` frames carry `{type: "..."}` in the body —
    //      pull `type` from there (events are typed in their JSON).
    //   2. Named `event: X` frames whose body has no `type` use the
    //      event name (matches the wire-log semantic the user expects:
    //      "what kind of event did the server send").
    const type =
      typeof raw.type === 'string'
        ? raw.type
        : eventName === 'message'
          ? 'unknown'
          : eventName
    // The full body becomes `data` so the drawer can render any
    // payload key the LLM-team added without a per-event mapping.
    // Strip the `type` field if it was promoted, otherwise it'd
    // duplicate.
    const { type: _t, ...rest } = raw
    void _t
    opts.onEvent({ campaignId, type, data: rest, receivedAt: Date.now() })
  }

  return {
    subscribe: (campaignId) => {
      if (open.has(campaignId)) return
      const es = new EventSource(opts.urlFor(campaignId))
      es.onmessage = (e) => {
        handleFrame(campaignId, 'message', String(e.data))
      }
      for (const name of NAMED_EVENTS) {
        es.addEventListener(name, (e) => {
          handleFrame(campaignId, name, String(e.data))
        })
      }
      open.set(campaignId, es)
    },
    unsubscribe: close,
    list: () => Array.from(open.keys()),
    closeAll: () => {
      for (const id of Array.from(open.keys())) {
        close(id)
      }
    },
  }
}
