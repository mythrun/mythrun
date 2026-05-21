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

  return {
    subscribe: (campaignId) => {
      if (open.has(campaignId)) return
      const es = new EventSource(opts.urlFor(campaignId))
      es.onmessage = (e) => {
        try {
          const raw = JSON.parse(String(e.data)) as { type?: unknown; data?: unknown }
          const type = typeof raw.type === 'string' ? raw.type : 'unknown'
          const data = typeof raw.data === 'object' && raw.data !== null
            ? (raw.data as Record<string, unknown>)
            : {}
          opts.onEvent({ campaignId, type, data, receivedAt: Date.now() })
        } catch {
          // malformed JSON frame — ignore.
        }
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
