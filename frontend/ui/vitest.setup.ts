import { afterEach, expect } from 'vitest'
import { cleanup } from '@testing-library/react'
import { toHaveNoViolations } from 'jest-axe'

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
