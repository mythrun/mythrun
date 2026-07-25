import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Stack } from './Stack.tsx'

// Behavior-tested with RTL + native DOM assertions (the harness registers
// jest-axe, not jest-dom). We assert the token CLASS the impl applies — jsdom
// does not compute Tailwind styles, so the class name is the observable contract.

describe('Stack', () => {
  it('renders its children inside a div', () => {
    const { getByTestId } = render(<Stack data-testid="stack">hello</Stack>)
    const el = getByTestId('stack')
    expect(el.tagName).toBe('DIV')
    expect(el.textContent).toBe('hello')
  })

  it('is a flex column by default', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    const el = getByTestId('stack')
    expect(el.classList.contains('flex')).toBe(true)
    expect(el.classList.contains('flex-col')).toBe(true)
  })

  it('lays out as a row when direction=row', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" direction="row">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('flex-row')).toBe(true)
  })

  it('applies the gap token class for the given SpaceToken', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" gap={4}>
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('gap-[var(--space-4)]')).toBe(true)
  })

  it('maps align to the corresponding align-items class', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" align="center">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('items-center')).toBe(true)
  })

  it('maps justify=between to justify-content: space-between', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" justify="between">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('justify-between')).toBe(true)
  })

  it('applies min-w-0 to its children so they can shrink under constraint', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    expect(getByTestId('stack').classList.contains('[&>*]:min-w-0')).toBe(true)
  })

  it('wraps children onto multiple lines when wrap is set', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" direction="row" wrap>
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(true)
  })

  it('does not wrap by default', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(false)
  })

  it('holds its size in a flex parent when noShrink is set (shrink-0)', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" direction="row" noShrink>
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('shrink-0')).toBe(true)
  })

  it('does not pin shrink by default (a group can shrink unless it opts out)', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    expect(getByTestId('stack').classList.contains('shrink-0')).toBe(false)
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Stack ref={ref} data-testid="stack">
        x
      </Stack>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('applies the dvh floor when minHeight="screen"', () => {
    render(<Stack minHeight="screen" data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('min-h-dvh')
  })

  it('floors at the in-frame content region when minHeight="page"', () => {
    // Viewport minus the app frame's fixed dressing — the floor that lets
    // grow-weighted spacers seat a short flow screen optically (myth-ma8yv).
    render(<Stack minHeight="page" data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('min-h-[calc(100dvh-8.5rem)]')
  })

  it('floors one flow-affordance row shy of the region when minHeight="pageBelowBar"', () => {
    // ux-run3 myth-4jbmr: a seated screen rendered UNDER the spine's Back bar
    // must subtract that row from its floor, or the column overflows the region
    // and the block seats below optical center.
    render(<Stack minHeight="pageBelowBar" data-testid="s" />)
    // 8.5rem (the page floor) + 2rem (--control-sm) + 2rem (the spine's gap-6).
    expect(screen.getByTestId('s').className).toContain('min-h-[calc(100dvh-12.5rem)]')
  })

  it('caps + centres the column when maxWidth is set (reading measure)', () => {
    render(<Stack maxWidth="form" data-testid="s" />)
    const el = screen.getByTestId('s')
    // The measure column: capped width, full up to the cap, centred via mx-auto.
    expect(el.className).toContain('max-w-[36rem]')
    expect(el.className).toContain('mx-auto')
    expect(el.className).toContain('w-full')
  })

  it('caps at the card-row content column when maxWidth="content" (~720px)', () => {
    render(<Stack maxWidth="content" data-testid="s" />)
    const el = screen.getByTestId('s')
    expect(el.className).toContain('max-w-[45rem]')
    expect(el.className).toContain('mx-auto')
    expect(el.className).toContain('w-full')
  })

  it('applies no max-width class when maxWidth is absent', () => {
    render(<Stack data-testid="s" />)
    expect(screen.getByTestId('s').className).not.toContain('mx-auto')
  })

  it('applies flex-grow when grow', () => {
    render(<Stack grow data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('grow')
  })

  it('applies a NUMERIC grow as an explicit flex-grow weight (no grow class)', () => {
    // A numeric grow is a proportional-spacer weight → inline flexGrow, not the
    // boolean `grow` (flex:1) class. (Two such spacers, grow={2}/grow={3}, seat
    // content optically above center.)
    render(<Stack grow={3} data-testid="s" />)
    const el = screen.getByTestId('s')
    expect(el.style.flexGrow).toBe('3')
    // The boolean fill class must NOT be present for the numeric case.
    expect(el.className.split(/\s+/)).not.toContain('grow')
  })

  it('does not set an inline flexGrow when grow is boolean/absent', () => {
    const withBool = render(<Stack grow data-testid="b" />)
    expect(withBool.getByTestId('b').style.flexGrow).toBe('')
    withBool.unmount()
    const none = render(<Stack data-testid="n" />)
    expect(none.getByTestId('n').style.flexGrow).toBe('')
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Stack gap={3} align="center" justify="between">
        <span>a</span>
        <span>b</span>
      </Stack>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
