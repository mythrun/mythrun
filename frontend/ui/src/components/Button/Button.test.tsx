import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Button } from './Button.tsx'

describe('Button', () => {
  it('renders a real <button> with its accessible name', () => {
    const { getByRole } = render(<Button>Save</Button>)
    const el = getByRole('button', { name: 'Save' })
    expect(el.tagName).toBe('BUTTON')
  })

  it('defaults to type="button" (never an accidental form submit)', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('honours an explicit type="submit"', () => {
    const { getByRole } = render(<Button type="submit">x</Button>)
    expect(getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it('calls onPress on click', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    await user.click(getByRole('button'))
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('calls onPress on keyboard activation (Enter)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('calls onPress on keyboard activation (Space)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    getByRole('button').focus()
    await user.keyboard(' ')
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('does NOT call onPress when disabled (click or keyboard)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Button onPress={onPress} disabled>
        go
      </Button>,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    await user.click(el)
    el.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('does NOT call onPress when loading (click or keyboard)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Button onPress={onPress} loading>
        go
      </Button>,
    )
    const el = getByRole('button')
    // Loading makes the control non-interactive (disabled while busy).
    expect(el).toBeDisabled()
    await user.click(el)
    el.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('exposes aria-busy + a Spinner when loading, keeping the label visible', () => {
    const { getByRole } = render(<Button loading>Saving</Button>)
    const el = getByRole('button')
    expect(el).toHaveAttribute('aria-busy', 'true')
    // The Spinner (role=status) renders inside the button…
    expect(el.querySelector('[role="status"]')).not.toBeNull()
    // …and the label stays visible alongside it (width doesn't collapse).
    expect(el).toHaveTextContent('Saving')
  })

  it('renders a proportionate in-button spinner: sm/md → 12px (xs), lg → 24px (sm)', () => {
    // The in-button spinner must sit balanced next to the label, not tower over
    // it. sm/md buttons (12/14px labels) get the 12px 'xs' spinner; the bigger lg
    // control (16px label) gets the 24px 'sm' spinner. The grid width reveals the
    // chosen Spinner size (xs=12px, sm=24px) — whole-pixel, crisp.
    const expected: Record<'sm' | 'md' | 'lg', string> = {
      sm: '12px',
      md: '12px',
      lg: '24px',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(
        <Button size={size} loading>
          Saving
        </Button>,
      )
      const grid = getByRole('button').querySelector<HTMLElement>('[data-spinner-grid]')
      expect(grid?.style.width).toBe(expected[size])
      unmount()
    }
  })

  it('renders the loading spinner with tone="inherit" so the pixels match the label color', () => {
    // The in-button spinner must read against the control fill: its pixels take
    // the label color (paper on the ember primary fill, ink on secondary/ghost),
    // NOT the brand ember — an ember spinner on the ember primary would vanish.
    // `tone="inherit"` ⇒ the Spinner grid carries NO `text-accent-fg` (it inherits
    // the button's text color), and the negative space stays transparent.
    const { getByRole } = render(<Button loading>Saving</Button>)
    const grid = getByRole('button').querySelector('[data-spinner-grid]')
    expect(grid?.className).not.toMatch(/\btext-accent-fg\b/)
    expect(grid?.className).not.toMatch(/bg-(surface|paper|accent|ember)/)
    // The pixels themselves are currentColor.
    const cell = grid?.querySelector('[data-spinner-cell]')
    expect(cell?.className).toMatch(/\bbg-current\b/)
  })

  it('does NOT set aria-busy when not loading', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent-fg',
    )
  })

  it('enforces a ≥44px touch target on COARSE pointers only (visual height stays --control-*)', () => {
    // WCAG 2.5.5: the 44px target matters on touch. On a fine pointer the visual
    // size hierarchy (32/40/48) is what matters, so the 44px floor rides the
    // `pointer-coarse:` variant and the base must NOT force a blanket min-height.
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      const el = getByRole('button')
      expect(el).toHaveClass('pointer-coarse:min-h-[44px]')
      // No unconditional min-h-[44px] inflating the desktop visual box.
      expect(el).not.toHaveClass('min-h-[44px]')
      unmount()
    }
  })

  it('opts out of flex-shrink so it keeps its size beside shrinking content (shrink-0)', () => {
    const { getByRole } = render(<Button>Settings</Button>)
    expect(getByRole('button')).toHaveClass('shrink-0')
  })

  it('renders distinct MIN heights per size (--control-sm/md/lg) so a long label grows, not clips', () => {
    const heights: Record<'sm' | 'md' | 'lg', string> = {
      sm: 'min-h-[var(--control-sm)]',
      md: 'min-h-[var(--control-md)]',
      lg: 'min-h-[var(--control-lg)]',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      expect(getByRole('button')).toHaveClass(heights[size])
      unmount()
    }
  })

  it('is responsive — caps at the container and wraps a long label (no viewport overflow)', () => {
    const { getByRole } = render(<Button>x</Button>)
    const el = getByRole('button')
    // max-w-full caps the button at its container; text-center centers wrapped lines;
    // no `whitespace-nowrap` so a long label wraps + the min-h button grows TALLER
    // (correct responsive design) rather than spilling past the viewport.
    expect(el).toHaveClass('max-w-full', 'text-center')
    expect(el).not.toHaveClass('whitespace-nowrap')
  })

  it('scales the font 12/14/16 per step so sizes are clearly distinct (sm text-xs)', () => {
    const fonts: Record<'sm' | 'md' | 'lg', string> = {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      expect(getByRole('button')).toHaveClass(fonts[size])
      unmount()
    }
  })

  it('uses flat 1-bit corners (no radius)', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass('rounded-none')
  })

  it('applies the primary accent fill + hover/active token-swap by default', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-accent',
      'text-paper-50',
      'hover:bg-accent-hover',
      'active:bg-accent-active',
    )
  })

  it('applies the secondary bordered neutral styling + hover/active pressed state', () => {
    const { getByRole } = render(<Button variant="secondary">x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-surface',
      'text-ink',
      'border-border-strong',
      'hover:bg-surface-hover',
      'active:bg-surface-active',
    )
  })

  it('applies the ghost transparent styling + hover/active pressed state', () => {
    const { getByRole } = render(<Button variant="ghost">x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-transparent',
      'text-ink',
      'hover:bg-surface-hover',
      'active:bg-surface-active',
    )
  })

  it('gives secondary AND ghost a pressed (active) state (was primary-only)', () => {
    for (const variant of ['secondary', 'ghost'] as const) {
      const { getByRole, unmount } = render(<Button variant={variant}>x</Button>)
      expect(getByRole('button')).toHaveClass('active:bg-surface-active')
      unmount()
    }
  })

  it('a disabled PRIMARY drops the accent entirely — muted ink on paper, never rust (myth-skbzw)', () => {
    // Run-2, world-reveal Continue: the accent-carrying disabled primary (the
    // MYT-0xao0 "ember ghost") was "visually indistinguishable from enabled. A
    // player who has waited ten minutes will click it and get nothing." The fix
    // inverts the old rationale: NO accent anywhere while non-interactive — a
    // paper fill, muted border, ~45% ink label — so the accent fill is the
    // exclusive mark of "clickable now", and it SNAPS in when enabled.
    const { getByRole } = render(<Button disabled>Begin</Button>)
    const el = getByRole('button')
    expect(el).toHaveClass('disabled:bg-surface', 'disabled:border-border', 'disabled:text-ink-tertiary')
    // No surviving accent in the disabled arm.
    expect(el).not.toHaveClass('disabled:border-accent-fg')
    expect(el).not.toHaveClass('disabled:text-accent-fg')
    // A rest-state transparent border reserves the 1px edge, so toggling disabled
    // fills/unfills without a reflow.
    expect(el).toHaveClass('border', 'border-transparent')
  })

  it('a disabled SECONDARY / GHOST reads as the same muted family (tertiary ink), per-variant geometry', () => {
    const secondary = render(
      <Button variant="secondary" disabled>
        x
      </Button>,
    )
    expect(secondary.getByRole('button')).toHaveClass('disabled:border-border', 'disabled:text-ink-tertiary')
    secondary.unmount()
    const ghost = render(
      <Button variant="ghost" disabled>
        <span>x</span>
      </Button>,
    )
    expect(ghost.getByRole('button')).toHaveClass('disabled:bg-transparent', 'disabled:text-ink-tertiary')
  })

  it('uses a plain default cursor when non-interactive, not the slashed not-allowed glyph', () => {
    // The critique prescribes cursor:default for the settling Continue — and the
    // not-allowed glyph is a slashed CIRCLE, which the register bans anyway.
    const { getByRole } = render(<Button disabled>x</Button>)
    const el = getByRole('button')
    expect(el).toHaveClass('disabled:cursor-default')
    expect(el).not.toHaveClass('disabled:cursor-not-allowed')
  })

  it('busy makes the control non-interactive with aria-busy + a Spinner (like loading)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Button onPress={onPress} busy>
        go
      </Button>,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    expect(el).toHaveAttribute('aria-busy', 'true')
    expect(el.querySelector('[role="status"]')).not.toBeNull()
    await user.click(el)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('busy wears the SAME muted treatment as disabled (no accent fill while working)', () => {
    // The world-reveal settling Continue is busy, not invalid — but it must be
    // just as legibly non-interactive: the accent fill only ever means
    // "pressable now". The muted arm rides the native disabled: variants, so
    // busy (which disables the control) is covered by construction.
    const { getByRole } = render(<Button busy>Continue</Button>)
    const el = getByRole('button')
    expect(el).toBeDisabled()
    expect(el).toHaveClass('disabled:bg-surface', 'disabled:border-border', 'disabled:text-ink-tertiary')
  })

  it('swaps the label to busyLabel while busy, and restores children when idle', () => {
    const busyRender = render(
      <Button busy busyLabel="Saving">
        Save
      </Button>,
    )
    const busyEl = busyRender.getByRole('button')
    expect(busyEl).toHaveTextContent('Saving')
    expect(busyEl).not.toHaveTextContent('Save')
    busyRender.unmount()
    // Idle: busyLabel is inert; the real label shows.
    const idle = render(<Button busyLabel="Saving">Save</Button>)
    const idleEl = idle.getByRole('button')
    expect(idleEl).toHaveTextContent('Save')
    expect(idleEl).not.toHaveTextContent('Saving')
    expect(idleEl).toBeEnabled()
  })

  it('keeps the still-visible children as the busy label when no busyLabel is given', () => {
    const { getByRole } = render(<Button busy>Save</Button>)
    expect(getByRole('button')).toHaveTextContent('Save')
  })

  it('honours the legacy `loading` alias for busyLabel swapping too', () => {
    const { getByRole } = render(
      <Button loading busyLabel="Weaving">
        Weave
      </Button>,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    expect(el).toHaveTextContent('Weaving')
  })

  it('renders a leading icon slot before the label, hidden from assistive tech', () => {
    const { getByRole, getByTestId } = render(
      <Button icon={<svg data-testid="lead-icon" />}>Continue</Button>,
    )
    const btn = getByRole('button', { name: 'Continue' })
    const icon = getByTestId('lead-icon')
    expect(btn).toContainElement(icon)
    // The slot wraps the icon in an aria-hidden span (the label carries the name)…
    const slot = icon.parentElement
    expect(slot).toHaveAttribute('aria-hidden', 'true')
    // …and it sits BEFORE the label (first child of the button).
    expect(btn.firstElementChild).toBe(slot)
  })

  it('applies the canonical 8px gap (--space-2) for an icon button, overriding the spinner gap', () => {
    const withIcon = render(<Button icon={<svg />}>Go</Button>)
    const cls = withIcon.getByRole('button').getAttribute('class') ?? ''
    // tailwind-merge resolves the gap conflict to the icon override (8px), dropping 6px.
    expect(cls).toContain('gap-[var(--space-2)]')
    expect(cls).not.toContain('gap-[6px]')
    withIcon.unmount()
    // Default md WITHOUT an icon keeps the spinner-tuned 6px gap (no override).
    const plain = render(<Button>Go</Button>)
    const plainCls = plain.getByRole('button').getAttribute('class') ?? ''
    expect(plainCls).toContain('gap-[6px]')
    expect(plainCls).not.toContain('gap-[var(--space-2)]')
  })

  it('omits the icon slot entirely when no icon is given', () => {
    const { getByRole } = render(<Button>Plain</Button>)
    expect(getByRole('button').querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('renders a trailing icon after the label', () => {
    render(<Button iconTrailing={<span data-testid="chev" />}>Name</Button>)
    const button = screen.getByRole('button')
    const chev = screen.getByTestId('chev')
    // Trailing: the icon is the LAST element child.
    expect(button.lastElementChild).toContainElement(chev)
  })

  it('applies the canonical 8px icon gap for a trailing-only icon (mirror of the leading slot)', () => {
    const cls = render(<Button iconTrailing={<svg />}>Go</Button>)
      .getByRole('button')
      .getAttribute('class') ?? ''
    expect(cls).toContain('gap-[var(--space-2)]')
    expect(cls).not.toContain('gap-[6px]')
  })

  it('truncate renders a single-line capped label', () => {
    render(<Button truncate>{'A'.repeat(120)}</Button>)
    const label = screen.getByText('A'.repeat(120))
    expect(label.className).toContain('truncate')
    expect(label.className).toContain('max-w-[16rem]')
  })

  it('has no axe violations with a leading icon', async () => {
    const { container } = render(
      <Button icon={<svg aria-hidden="true" />}>Continue with Provider</Button>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('forwards its ref to the underlying button', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>x</Button>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('forwards aria-expanded + aria-controls to the underlying <button> (disclosure trigger)', () => {
    // The DS Button is the sanctioned control for a WAI-ARIA disclosure toggle (e.g.
    // the CharacterSheetReveal "See full sheet" expander): the contract carries the
    // two disclosure aria props explicitly, forwarded to the real <button> so the
    // toggle exposes aria-expanded (open/closed) + aria-controls (the panel id). The
    // `expanded` role option asserts aria-expanded is present with the right value.
    const collapsed = render(
      <Button aria-expanded={false} aria-controls="sheet-panel">
        Toggle
      </Button>,
    )
    expect(collapsed.getByRole('button', { expanded: false })).toHaveAttribute(
      'aria-controls',
      'sheet-panel',
    )
    collapsed.unmount()

    const expanded = render(
      <Button aria-expanded aria-controls="sheet-panel">
        Toggle
      </Button>,
    )
    expect(expanded.getByRole('button', { expanded: true })).toHaveAttribute(
      'aria-controls',
      'sheet-panel',
    )
  })

  it('forwards aria-pressed to the underlying <button> (toggle button state)', () => {
    // The DS Button is also the sanctioned control for a WAI-ARIA TOGGLE button —
    // a segmented single-select where each option reports its on/off state (e.g.
    // PackList's à-la-carte quantity presets). The contract carries aria-pressed
    // explicitly, forwarded to the real <button> so the toggle exposes its
    // pressed/selected state. The `pressed` role option asserts aria-pressed is
    // present with the right value.
    const off = render(<Button aria-pressed={false}>Preset</Button>)
    expect(off.getByRole('button', { pressed: false })).toBeInTheDocument()
    off.unmount()

    const on = render(<Button aria-pressed>Preset</Button>)
    expect(on.getByRole('button', { pressed: true })).toBeInTheDocument()
  })

  it('flush="start" bleeds the size\'s own start padding so the glyph seats on the grid', () => {
    // ux-run3 myth-4jbmr: a ghost Back on a text column indents its arrow by the
    // hit-area padding — flush pulls the visual edge back with a negative
    // inline-start margin exactly equal to the size's horizontal padding.
    const { getByRole, rerender } = render(
      <Button variant="ghost" size="sm" flush="start">
        Back
      </Button>,
    )
    expect(getByRole('button').className).toContain('-ms-[var(--space-3)]')
    rerender(
      <Button variant="ghost" size="lg" flush="start">
        Back
      </Button>,
    )
    expect(getByRole('button').className).toContain('-ms-[var(--space-5)]')
    rerender(
      <Button variant="ghost" size="sm">
        Back
      </Button>,
    )
    expect(getByRole('button').className).not.toContain('-ms-')
  })

  it('has no axe violations (default / disabled / busy / loading)', async () => {
    const { container } = render(
      <div>
        <Button>Save</Button>
        <Button disabled>Disabled</Button>
        <Button busy busyLabel="Saving">
          Save
        </Button>
        <Button loading>Saving</Button>
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
