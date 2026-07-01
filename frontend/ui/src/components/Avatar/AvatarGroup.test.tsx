import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Avatar } from './Avatar.tsx'
import { AvatarGroup } from './AvatarGroup.tsx'

// AvatarGroup clusters Avatars with a token overlap RING so each face reads as a
// distinct square. The Avatar Root is `role="img"` + `aria-label={name}`, so each
// face is found by its name; the ring lives on the WRAPPER span around each
// overlapping avatar (`getByRole('img').parentElement`).

describe('AvatarGroup', () => {
  const five = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Ken Thompson']

  it('renders every child when under the cap', () => {
    render(
      <AvatarGroup max={5}>
        {five.slice(0, 3).map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByLabelText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByLabelText('Alan Turing')).toBeInTheDocument()
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it('caps at max and shows a +N overflow chip for the remainder', () => {
    render(
      <AvatarGroup max={3}>
        {five.map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    // Only the first 3 render as avatars.
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByLabelText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByLabelText('Alan Turing')).toBeInTheDocument()
    expect(screen.queryByLabelText('Edsger Dijkstra')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Ken Thompson')).not.toBeInTheDocument()
    // The overflow shows the count of the 2 hidden avatars.
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('omits the overflow chip when the children exactly fill the cap', () => {
    render(
      <AvatarGroup max={3}>
        {five.slice(0, 3).map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it('renders all children when no max is given', () => {
    const { container } = render(
      <AvatarGroup>
        {five.map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    for (const n of five) expect(within(container).getByLabelText(n)).toBeInTheDocument()
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  // The overlap ring matches the SURFACE the cluster sits on so it reads as a
  // clean separation, not a mismatched halo. Default `'bg'` rings in the page
  // color; `'surface'` rings in the Card color. The ring is on the wrapper span
  // around every overlapping (non-first) avatar.
  it('rings overlapping faces with ring-bg by default (page surface)', () => {
    render(
      <AvatarGroup>
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
      </AvatarGroup>,
    )
    const overlapped = screen.getByRole('img', { name: 'Grace Hopper' }).parentElement
    expect(overlapped).toHaveClass('ring-bg')
    expect(overlapped).not.toHaveClass('ring-surface')
  })

  it('rings overlapping faces with ring-surface when surface="surface" (on a Card)', () => {
    render(
      <AvatarGroup surface="surface">
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
      </AvatarGroup>,
    )
    const overlapped = screen.getByRole('img', { name: 'Grace Hopper' }).parentElement
    expect(overlapped).toHaveClass('ring-surface')
    expect(overlapped).not.toHaveClass('ring-bg')
  })

  // The +N overflow chip stands in for real Avatars, so it must be the SAME size
  // as the seals it replaces — the group's `size` prop drives both. With `sm`
  // seals (as the campaign cards render) the chip must be `sm`, not the md default
  // that towered over the 32px seals.
  it('sizes the +N chip to the group size (sm → sm control token, matching the seals)', () => {
    render(
      <AvatarGroup max={2} size="sm">
        {five.map((n) => (
          <Avatar key={n} name={n} size="sm" />
        ))}
      </AvatarGroup>,
    )
    const chip = screen.getByText('+3')
    // Same control token + text size as an `sm` Avatar seal.
    expect(chip).toHaveClass('w-[var(--control-sm)]')
    expect(chip).toHaveClass('h-[var(--control-sm)]')
    expect(chip).toHaveClass('text-xs')
    // NOT the old hardcoded md default that dwarfed the sm seals.
    expect(chip).not.toHaveClass('w-[var(--control-md)]')
    expect(chip).not.toHaveClass('h-[var(--control-md)]')
    expect(chip).not.toHaveClass('text-sm')
  })

  it("the +N chip carries the SAME size classes as a shown seal's frame", () => {
    render(
      <AvatarGroup max={2} size="sm">
        {five.map((n) => (
          <Avatar key={n} name={n} size="sm" />
        ))}
      </AvatarGroup>,
    )
    const seal = screen.getByRole('img', { name: 'Ada Lovelace' })
    const chip = screen.getByText('+3')
    // Every control/text-size class on the seal frame is also on the chip, so the
    // two render at identical dimensions.
    for (const cls of ['w-[var(--control-sm)]', 'h-[var(--control-sm)]', 'text-xs']) {
      expect(seal).toHaveClass(cls)
      expect(chip).toHaveClass(cls)
    }
  })

  it('defaults the +N chip to md when no size is given (existing behavior preserved)', () => {
    render(
      <AvatarGroup max={2}>
        {five.map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    const chip = screen.getByText('+3')
    expect(chip).toHaveClass('w-[var(--control-md)]')
    expect(chip).toHaveClass('h-[var(--control-md)]')
    expect(chip).toHaveClass('text-sm')
  })

  it('rings the +N overflow chip to match surface="surface" too', () => {
    render(
      <AvatarGroup max={2} surface="surface">
        {five.map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    const chip = screen.getByText('+3')
    expect(chip).toHaveClass('ring-surface')
    expect(chip).not.toHaveClass('ring-bg')
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <AvatarGroup max={3}>
        {five.map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </AvatarGroup>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
