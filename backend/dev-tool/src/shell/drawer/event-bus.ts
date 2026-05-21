// backend/dev-tool/src/shell/drawer/event-bus.ts
//
// myth-mbdc: in-process pub/sub. The drawer's EventSource lifecycle
// publishes here; long-running panel feedback panes subscribe (filtered
// to their own campaign id). One SSE socket per campaign; many readers.

export interface EventBus<T> {
  publish(event: T): void
  subscribe(cb: (event: T) => void): () => void
}

export function createEventBus<T>(): EventBus<T> {
  const subscribers = new Set<(event: T) => void>()
  return {
    publish: (event) => {
      for (const cb of subscribers) {
        try {
          cb(event)
        } catch {
          // a misbehaving subscriber must not prevent siblings from
          // receiving the event. Errors are swallowed; subscribers
          // should report their own diagnostic on throw.
        }
      }
    },
    subscribe: (cb) => {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
  }
}
