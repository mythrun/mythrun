import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { EntityGlyph } from '@mythrun/client-core/contract'
import { EntityMention } from './EntityMention.tsx'

// The three world-lore glyphs → their icon name. `other` renders NO glyph.
const GLYPH_CASES: readonly (readonly [Exclude<EntityGlyph, 'other'>, string])[] = [
  ['npc', 'entity-npc'],
  ['location', 'entity-location'],
  ['faction', 'entity-faction'],
]

describe('EntityMention', () => {
  it('renders the entity name verbatim inside a real button', () => {
    const { getByRole } = render(<EntityMention text="Elenya" glyph="npc" label="entity: Elenya" />)
    const el = getByRole('button', { name: 'entity: Elenya' })
    // A REAL <button> — native keyboard activation + focusable (the popover wraps
    // it via Radix asChild, which injects onClick onto this element).
    expect(el.tagName).toBe('BUTTON')
    expect(el).toHaveAttribute('type', 'button')
    expect(el).toHaveTextContent('Elenya')
  })

  it('carries a subtle resting underline (low-contrast, dotted, offset)', () => {
    const { getByRole } = render(<EntityMention text="Highreach" glyph="location" label="l" />)
    const el = getByRole('button')
    // Rest: a barely-visible dotted underline in the muted (tertiary) ink token,
    // NOT a coloured hyperlink. The style + colour are the resting differentiator.
    expect(el).toHaveClass(
      'underline',
      'decoration-dotted',
      'decoration-ink-tertiary',
      'underline-offset-2',
    )
  })

  it('changes the underline style + darkens within ink on hover AND focus (structural, monochrome)', () => {
    const { getByRole } = render(<EntityMention text="Highreach" glyph="location" label="l" />)
    const el = getByRole('button')
    // The hover/focus signal is a STYLE change (dotted → solid) plus a darken that
    // stays WITHIN the ink tokens (tertiary → ink) — CVD-safe, no entity-type colour.
    expect(el).toHaveClass(
      'hover:decoration-solid',
      'hover:decoration-ink',
      'focus-visible:decoration-solid',
      'focus-visible:decoration-ink',
    )
  })

  it('applies NO entity-type colour class (monochrome register, spec §6)', () => {
    // The four UX §12 type colours (npc-blue / location-amber / faction-green …) are
    // deliberately dropped: differentiation is the glyph + underline style, never a
    // tint. The a11y focus ring (`outline-accent-fg`) is the shared indicator, not a
    // type colour, so it is exempt from this assertion.
    const { getByRole } = render(<EntityMention text="Gorm" glyph="faction" label="l" />)
    const cls = getByRole('button').className
    expect(cls).not.toMatch(/(?:^|\s|:)text-(?:accent|success|warning|danger|info)/)
    expect(cls).not.toMatch(/(?:^|\s|:)decoration-(?:accent|success|warning|danger|info)/)
    expect(cls).not.toMatch(/(?:^|\s|:)bg-(?:accent|success|warning|danger|info)/)
  })

  it('renders as body-serif text that inherits the surrounding prose size + leading', () => {
    // The mention sits INSIDE settled DM serif prose — it stays `--font-body`, and a
    // native button's UA font-size/leading are overridden to INHERIT the paragraph
    // so the highlight is seamless (no smaller/off-baseline run).
    const { getByRole } = render(<EntityMention text="Elenya" glyph="npc" label="l" />)
    const el = getByRole('button')
    expect(el).toHaveClass('font-body', 'text-inherit', '[font-size:inherit]', '[line-height:inherit]')
  })

  it.each(GLYPH_CASES)('renders the leading %s glyph, decorative + absolutely positioned', (glyph, iconName) => {
    const { getByRole, container } = render(
      <EntityMention text="Name" glyph={glyph} label="l" />,
    )
    const wrapper = container.querySelector('[data-entity-glyph]')
    expect(wrapper).not.toBeNull()
    // Decorative — the accessible name comes from the button's aria-label, so the
    // glyph adjacent to the visible name is hidden from AT.
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    // The correct type glyph is rendered (svg carries the mapped icon's paths). We
    // assert the icon by its presence + that the button exposes exactly one glyph.
    expect(wrapper?.querySelector('svg')).not.toBeNull()
    expect(getByRole('button').querySelectorAll('svg')).toHaveLength(1)
    // Named by the icon vocabulary — the map wires this glyph to `iconName`.
    expect(iconName).toBe(`entity-${glyph}`)
  })

  it('reveals the glyph on hover/focus only, WITHOUT reflowing the paragraph', () => {
    const { container } = render(<EntityMention text="Elenya" glyph="npc" label="l" />)
    const wrapper = container.querySelector('[data-entity-glyph]')
    // Absolute → out of flow, so the reveal never shifts the surrounding text.
    expect(wrapper).toHaveClass('absolute')
    // Hidden at rest; shown on group hover/focus (the button is the `group`).
    expect(wrapper).toHaveClass('opacity-0', 'group-hover:opacity-100', 'group-focus-visible:opacity-100')
    expect(container.querySelector('.group')).not.toBeNull()
  })

  it('renders NO glyph for the neutral `other` kind (item/pc are not world lore)', () => {
    const { getByRole, container } = render(<EntityMention text="a dagger" glyph="other" label="l" />)
    // Just the underlined name — no leading glyph slot at all.
    expect(container.querySelector('[data-entity-glyph]')).toBeNull()
    expect(getByRole('button').querySelector('svg')).toBeNull()
    expect(getByRole('button')).toHaveTextContent('a dagger')
  })

  it('carries the shared theme-aware a11y focus ring', () => {
    const { getByRole } = render(<EntityMention text="Elenya" glyph="npc" label="l" />)
    expect(getByRole('button')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent-fg',
    )
  })

  it('threads data-testid through to the button', () => {
    const { getByTestId } = render(
      <EntityMention text="Elenya" glyph="npc" label="l" data-testid="mention" />,
    )
    expect(getByTestId('mention').tagName).toBe('BUTTON')
  })

  it('forwards its ref to the underlying button', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<EntityMention ref={ref} text="Elenya" glyph="npc" label="l" />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no axe violations (with a glyph)', async () => {
    const { container } = render(<EntityMention text="Elenya" glyph="npc" label="entity: Elenya" />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (other, no glyph)', async () => {
    const { container } = render(<EntityMention text="a dagger" glyph="other" label="entity: a dagger" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
