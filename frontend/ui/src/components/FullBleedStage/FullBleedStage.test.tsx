import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { FullBleedStage } from './FullBleedStage.tsx'

// FullBleedStage (MYT-89 audit v2: mobile full-bleed) — the narrow-viewport
// full-screen stage. Inside a framed page (a header bar above, a token-padded
// content box around), a stage on a phone-class viewport (< 640px) CANCELS the
// host's content inset (negative margins at the same `--space-*` step) and
// FILLS the viewport below whatever sits above it (a measured top offset →
// `height: calc(100dvh - top)`), laying its children out as a flex column. On a
// wide viewport it is a plain block — the wrapped content renders exactly as if
// the stage weren't there (the desktop zero-change guarantee).

/** Stub `matchMedia` to a chosen viewport regime (jsdom has none). */
function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 640px)' ? !narrow : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FullBleedStage — wide viewport (the desktop zero-change guarantee)', () => {
  it('renders children in a plain block: no bleed margins, no forced height', () => {
    stubViewport(false)
    const { getByTestId, getByText } = render(
      <FullBleedStage inset={6} data-testid="stage">
        <p>content</p>
      </FullBleedStage>,
    )
    const stage = getByTestId('stage')
    expect(getByText('content')).toBeInTheDocument()
    expect(stage.className).not.toMatch(/-m-/)
    expect(stage.style.height).toBe('')
  })

  it('renders the plain block when there is no matchMedia at all (jsdom default)', () => {
    const { getByTestId } = render(
      <FullBleedStage inset={6} data-testid="stage">
        <p>content</p>
      </FullBleedStage>,
    )
    expect(getByTestId('stage').className).not.toMatch(/-m-/)
  })
})

describe('FullBleedStage — narrow viewport (the full-screen stage)', () => {
  it('cancels the host inset with negative margins at the same token step', () => {
    stubViewport(true)
    const { getByTestId } = render(
      <FullBleedStage inset={6} data-testid="stage">
        <p>content</p>
      </FullBleedStage>,
    )
    expect(getByTestId('stage').className).toMatch(/-m-\[var\(--space-6\)\]/)
  })

  it('fills the viewport below its own top edge and stacks children as a column', () => {
    stubViewport(true)
    const { getByTestId } = render(
      <FullBleedStage inset={6} data-testid="stage">
        <p>content</p>
      </FullBleedStage>,
    )
    const stage = getByTestId('stage')
    // jsdom measures a 0 top — the SHAPE of the height is the contract: the dvh
    // calc FLOORED (max()) at the measured real viewport (`innerHeight - top`),
    // because current Safari (26.x, and its responsive-design-mode presets) can
    // resolve 100dvh SMALLER than the actual viewport — the floating-footer bug
    // (MYT-89 audit v3 item 6). Where dvh is honest the two operands agree and
    // max() is a no-op; where dvh under-reports, the measured floor wins.
    // (Substring asserts: jsdom's cssstyle mangles max()/calc() serialization.)
    expect(stage.style.height).toContain('max(')
    expect(stage.style.height).toContain('100dvh - 0px')
    expect(stage.className).toMatch(/flex-col/)
    expect(stage.className).toMatch(/min-w-0/)
  })

  it('floors the dvh calc at the measured viewport remainder (innerHeight − top)', () => {
    stubViewport(true)
    vi.stubGlobal('innerHeight', 667)
    const { getByTestId } = render(
      <FullBleedStage inset={6} data-testid="stage">
        <p>content</p>
      </FullBleedStage>,
    )
    // top measures 0 under jsdom → the floor is the full innerHeight.
    expect(getByTestId('stage').style.height).toContain('667px')
  })
})
