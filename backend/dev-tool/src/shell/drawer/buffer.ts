// backend/dev-tool/src/shell/drawer/buffer.ts
//
// myth-mbdc: FIFO ring buffer for the drawer's 500-event in-memory
// log. Cap configured by callers (production passes 500); oldest
// items evict on overflow. items() returns a defensive copy so
// renderers can iterate freely without mutating buffer state.

export interface RingBuffer<T> {
  push(item: T): void
  items(): readonly T[]
  size(): number
  clear(): void
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const buf: T[] = []
  return {
    push: (item) => {
      buf.push(item)
      while (buf.length > capacity) {
        buf.shift()
      }
    },
    items: () => buf.slice(),
    size: () => buf.length,
    clear: () => { buf.length = 0 },
  }
}
