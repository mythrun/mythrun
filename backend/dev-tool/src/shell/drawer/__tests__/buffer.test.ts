import { describe, it, expect } from 'vitest'
import { createRingBuffer } from '../buffer.js'

describe('drawer ring buffer', () => {
  it('keeps the last N items; older items evict FIFO', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2); b.push(3); b.push(4)
    expect(b.items()).toEqual([2, 3, 4])
  })

  it('clear removes everything', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2)
    b.clear()
    expect(b.items()).toEqual([])
  })

  it('size reports current length', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2)
    expect(b.size()).toBe(2)
  })

  it('items() returns a defensive copy (mutating the result does not affect the buffer)', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2)
    const snapshot = b.items() as number[]
    snapshot.push(99)
    expect(b.items()).toEqual([1, 2])
  })
})
