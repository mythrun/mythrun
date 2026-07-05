import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorldGenGraphProps } from '@mythrun/ui'
import { i18n } from '../../i18n/config.ts'
import { GeneratingView } from './generating.tsx'

// GeneratingView is the SOLE production consumer of <WorldGenGraph>. This test
// pins the reduced-motion wiring: the view must read the OS/browser
// `prefers-reduced-motion` preference and hand the graph the boolean, so the
// graph's Canvas rAF loop is suppressed for users who asked for reduced motion
// (the global CSS reduce-block can't stop a JS rAF loop). WorldGenGraph itself is
// mocked to a props spy — its own honoring of `reducedMotion` is covered in its
// unit test; here we only assert the prop is threaded through.

const { graphSpy } = vi.hoisted(() => ({ graphSpy: vi.fn() }))

vi.mock('@mythrun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/ui')>()
  return {
    ...actual,
    WorldGenGraph: (props: WorldGenGraphProps): null => {
      graphSpy(props)
      return null
    },
  }
})

// jsdom has no matchMedia; install a query-aware one so this view's
// prefers-reduced-motion read resolves to the value under test.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

function renderGenerating(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneratingView nodes={[]} edges={[]} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('GeneratingView — reduced-motion wiring', () => {
  it('passes reducedMotion={true} to WorldGenGraph when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: true }))
  })

  it('passes reducedMotion={false} by default (no preference set)', () => {
    mockMatchMedia(false)
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })

  it('passes reducedMotion={false} when matchMedia is unavailable (SSR-safe default)', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })
})
