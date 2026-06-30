import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Avatar } from './Avatar.tsx'
import { avatarColorFor } from './avatar-color.ts'

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

  it('applies the explicit pigment as a bg-avatar-* utility on the fallback', () => {
    render(<Avatar name="Ada Lovelace" color="lapis" />)
    const fallback = screen.getByText('AL')
    expect(fallback).toHaveClass('bg-avatar-lapis')
  })

  it('an explicit color OVERRIDES the name-derived auto color', () => {
    // 'iris' is a deliberate, almost-certainly-not-auto pick; the prop must win.
    render(<Avatar name="Grace Hopper" color="iris" />)
    const fallback = screen.getByText('GH')
    expect(fallback).toHaveClass('bg-avatar-iris')
    // and NOT the surface chip default from before the color prop existed.
    expect(fallback).not.toHaveClass('bg-surface')
  })

  it('auto-assigns a deterministic pigment from the name when color is omitted', () => {
    render(<Avatar name="Ada Lovelace" />)
    const fallback = screen.getByText('AL')
    expect(fallback).toHaveClass(`bg-avatar-${avatarColorFor('Ada Lovelace')}`)
  })

  it('maps the same name to the same pigment across renders', () => {
    const first = render(<Avatar name="Edsger Dijkstra" />)
    const a = first.getByText('ED').className
    first.unmount()
    const second = render(<Avatar name="Edsger Dijkstra" />)
    const b = second.getByText('ED').className
    expect(b).toBe(a)
  })

  it('spreads different names across distinct pigments', () => {
    const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Ken Thompson', 'Barbara Liskov']
    const pigments = new Set(names.map(avatarColorFor))
    // The auto-assign should not collapse a handful of distinct names onto one.
    expect(pigments.size).toBeGreaterThanOrEqual(2)
  })

  it('draws paper-50 initials on the pigment chip, with the border on the root', () => {
    render(<Avatar name="Ada Lovelace" color="pine" />)
    const fallback = screen.getByText('AL')
    expect(fallback).toHaveClass('text-paper-50')
    // The 1px square frame lives on the ROOT (so the image variant is bordered
    // too) — not on the chip, which only carries the pigment + initials.
    const root = screen.getByRole('img', { name: 'Ada Lovelace' })
    expect(root).toHaveClass('border')
    expect(root).toHaveClass('border-border-strong')
  })

  it('an IMAGE avatar carries the same 1px border-strong square frame', () => {
    render(<Avatar name="Ada Lovelace" src="https://example.test/ada.png" />)
    const root = screen.getByRole('img', { name: 'Ada Lovelace' })
    expect(root).toHaveClass('border')
    expect(root).toHaveClass('border-border-strong')
    expect(root).toHaveClass('rounded-none')
  })

  it('has no axe violations (image + fallback)', async () => {
    const withImg = render(<Avatar name="Ada Lovelace" src="https://example.test/ada.png" />)
    expect(await axe(withImg.container)).toHaveNoViolations()
    withImg.unmount()
    const withFallback = render(<Avatar name="Grace Hopper" />)
    expect(await axe(withFallback.container)).toHaveNoViolations()
  })
})
