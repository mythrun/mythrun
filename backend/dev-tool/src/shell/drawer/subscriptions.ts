// backend/dev-tool/src/shell/drawer/subscriptions.ts
//
// myth-mbdc: SSE lifecycle manager for the wire-log drawer.
//
// myth-y58n: uses the fetch-based `openSse()` helper (sse-client.ts),
// NOT the browser-native EventSource. EventSource cannot set custom
// request headers, which means it cannot carry `x-mythrun-dev-sub` —
// the dev backend's auth plugin then 403s every connection and the
// drawer stays empty. openSse() reads SSE over `fetch` and stamps the
// dev-identity header the same way `apiCall` does.

import { openSse, type SseConnection } from '../../sse-client.js'

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
  const open = new Map<string, SseConnection>()

  function close(campaignId: string): void {
    const conn = open.get(campaignId)
    if (conn !== undefined) {
      conn.close()
      open.delete(campaignId)
    }
  }

  function handleFrame(campaignId: string, eventName: string, data: string): void {
    let raw: { type?: unknown; data?: unknown } & Record<string, unknown>
    try {
      raw = JSON.parse(data) as { type?: unknown; data?: unknown } & Record<string, unknown>
    } catch {
      return
    }
    // Unnamed `data:` frames carry `{type: "..."}` in the body; named
    // `event: X` frames whose body has no `type` use the event name.
    // openSse normalizes the unnamed case to event === 'message'.
    const type =
      typeof raw.type === 'string'
        ? raw.type
        : eventName === 'message'
          ? 'unknown'
          : eventName
    const { type: _t, ...rest } = raw
    void _t
    opts.onEvent({ campaignId, type, data: rest, receivedAt: Date.now() })
  }

  return {
    subscribe: (campaignId) => {
      if (open.has(campaignId)) return
      const conn = openSse(opts.urlFor(campaignId), {
        onEvent: (e) => {
          handleFrame(campaignId, e.event, e.data)
        },
      })
      open.set(campaignId, conn)
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
