import { afterEach, expect } from 'vitest'
import { cleanup } from '@testing-library/react'
import { toHaveNoViolations } from 'jest-axe'
// jest-dom matchers (toBeInTheDocument / toHaveAttribute / toHaveClass) for
// component tests. Registered from W1b onward — earlier tests used native DOM
// assertions and are not migrated.
import '@testing-library/jest-dom/vitest'

// Register the axe accessibility matcher (`expect(...).toHaveNoViolations()`)
// for every component test. Components in this library are behavior-tested
// with RTL and a11y-asserted with jest-axe.
expect.extend(toHaveNoViolations)

// React Testing Library does not auto-clean between tests under Vitest the way
// it does under Jest's globals, so unmount + reset the DOM after each test to
// keep tests isolated.
afterEach(() => {
  cleanup()
})

// jsdom gaps for Radix primitives. Radix Select (and other Popper-positioned
// primitives) call Pointer Capture + scrollIntoView APIs that jsdom does not
// implement; without these shims the open/keyboard interaction tests throw
// instead of exercising the real behavior. These are ENVIRONMENT polyfills (a
// known jsdom gap), not production code — they live in the test setup only.
//
// TS types these methods as always-present on Element.prototype (the DOM lib
// declares them), so the runtime assignment goes through an `unknown` cast —
// jsdom genuinely lacks them and the no-op bodies are deliberate.
const elementProto = Element.prototype as unknown as {
  hasPointerCapture: () => boolean
  setPointerCapture: () => void
  releasePointerCapture: () => void
  scrollIntoView: () => void
}
elementProto.hasPointerCapture = () => false
elementProto.setPointerCapture = () => undefined
elementProto.releasePointerCapture = () => undefined
elementProto.scrollIntoView = () => undefined

// Radix overlays that POSITION a portalled layer (Popover, Tooltip, DropdownMenu
// via @floating-ui) observe the trigger/content geometry with ResizeObserver,
// which jsdom does not implement. Without this shim the open path throws on
// `new ResizeObserver(...)` instead of exercising the keyboard/focus behavior.
// A no-op observer is sufficient: the tests assert open/close + focus + ARIA, not
// pixel placement (jsdom has no layout). ENVIRONMENT polyfill, not production.
if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {
      return undefined
    }
    unobserve() {
      return undefined
    }
    disconnect() {
      return undefined
    }
  }
}
