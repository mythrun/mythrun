import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Avatar } from './Avatar.tsx'
import { AvatarGroup } from './AvatarGroup.tsx'

// The avatar Root is `role="img"` + `aria-label={name}` — it carries the
// identity name in EVERY load state, so the avatar is named whether the image
// loads, fails, or is absent. The inner <img> is decorative (alt=""; the Root
// names it). Radix tracks image load via an OFF-DOM `new window.Image()` (not a
// DOM <img>), and only mounts the `<img>` element once that reports `loaded` —
// which jsdom never fires. So the image-RENDERS path is exercised in Storybook
// (a real browser); here we assert the Root is named for the src case, and the
// FALLBACK (initials) for the no-/broken-src cases (jsdom's off-DOM Image errors,
// so the fallback is what shows).

describe('Avatar', () => {
  it('is named by the Root when given a src (named in every load state)', () => {
    render(<Avatar name="Ada Lovelace" src="https://example.test/ada.png" />)
    // The Root carries the accessible name regardless of the image's load state.
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeInTheDocument()
  })

  it('falls back to 1–2 initials derived from name when src is absent', () => {
    render(<Avatar name="Ada Lovelace" />)
    // First letters of the first two words, uppercased.
    expect(screen.getByText('AL')).toBeInTheDocument()
  })

  it('derives a single initial from a one-word name', () => {
    render(<Avatar name="merlin" />)
    expect(screen.getByText('M')).toBeInTheDocument()
  })

  it('labels the fallback with the name for assistive tech', () => {
    render(<Avatar name="Ada Lovelace" />)
    // The avatar root carries the accessible name even when only initials show.
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
  })

  it('applies the size token class', () => {
    const { container } = render(<Avatar name="Ada" size="lg" />)
    expect(container.querySelector('[class*="control-lg"]')).not.toBeNull()
  })

  it('is SQUARE (0px radius, §3 — no rounded exception)', () => {
    const { container } = render(<Avatar name="Ada" />)
    const root = screen.getByRole('img', { name: 'Ada' })
    expect(root).toHaveClass('rounded-none')
    expect(root).not.toHaveClass('rounded-full')
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Avatar ref={ref} name="Ada" />)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no axe violations (image + fallback)', async () => {
    const withImg = render(<Avatar name="Ada Lovelace" src="https://example.test/ada.png" />)
    expect(await axe(withImg.container)).toHaveNoViolations()
    withImg.unmount()
    const withFallback = render(<Avatar name="Grace Hopper" />)
    expect(await axe(withFallback.container)).toHaveNoViolations()
  })
})

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
