import { expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { IntersectionObserverStub } from '../../../test/intersection-observer-stub.ts'
import { useScrollElevation } from './use-scroll-elevation.ts'

function drive(intersecting: boolean) {
  const io = IntersectionObserverStub.instances.at(-1)
  act(() => {
    io?.callback([{ isIntersecting: intersecting } as IntersectionObserverEntry], io)
  })
}

it('not elevated while the sentinel intersects; elevated once it leaves', () => {
  const { result } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  drive(true)
  expect(result.current.elevated).toBe(false)
  drive(false)
  expect(result.current.elevated).toBe(true)
})

it('forceElevated wins regardless of observation', () => {
  const { result } = renderHook(() => useScrollElevation(true))
  expect(result.current.elevated).toBe(true)
})

it('disconnects on unmount and on ref detach', () => {
  const { result, unmount } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  const io = IntersectionObserverStub.instances.at(-1)
  unmount()
  expect(io?.disconnect).toHaveBeenCalled()
})

it('ref detach disconnects the observer without waiting for unmount', () => {
  const { result } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  const io = IntersectionObserverStub.instances.at(-1)
  act(() => result.current.sentinelRef(null))
  expect(io?.disconnect).toHaveBeenCalled()
})

it('ignores an empty entries batch (state holds)', () => {
  const { result } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  drive(false)
  expect(result.current.elevated).toBe(true)
  const io = IntersectionObserverStub.instances.at(-1)
  act(() => {
    io?.callback([], io)
  })
  expect(result.current.elevated).toBe(true)
})
