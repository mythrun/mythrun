import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Link } from './Link.tsx'

describe('Link', () => {
  it('renders a real anchor with its href and accessible name', () => {
    const { getByRole } = render(<Link href="/world">World</Link>)
    const el = getByRole('link', { name: 'World' })
    expect(el.tagName).toBe('A')
    expect(el).toHaveAttribute('href', '/world')
  })

  it('calls onPress when activated', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Link href="#" onPress={onPress}>
        go
      </Link>,
    )
    await user.click(getByRole('link'))
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('adds target+rel for external links', () => {
    const { getByRole } = render(
      <Link href="https://example.com" external>
        out
      </Link>,
    )
    const el = getByRole('link')
    expect(el).toHaveAttribute('target', '_blank')
    expect(el).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not set target/rel for internal links', () => {
    const { getByRole } = render(<Link href="/x">in</Link>)
    const el = getByRole('link')
    expect(el).not.toHaveAttribute('target')
    expect(el).not.toHaveAttribute('rel')
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<Link href="/x">x</Link>)
    const el = getByRole('link')
    // The focus ring is a11y-critical: 2px hard outline in the FOREGROUND accent
    // (== --focus-ring-color → --accent-fg, theme-aware), 2px offset, on kbd focus.
    expect(el).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent-fg',
    )
  })

  it('uses the FOREGROUND accent for link text (not the fill --accent)', () => {
    // Link text is accent drawn ON the page, so it must contrast against the page.
    // In dark mode the fill --accent is darkened for on-accent text AA and would
    // read sub-4.5:1 as link text — so the link uses --accent-fg (MYT-86 split).
    const { getByRole } = render(<Link href="/x">x</Link>)
    expect(getByRole('link')).toHaveClass('text-accent-fg', 'hover:text-accent-fg-hover')
  })

  it('forwards its ref to the underlying anchor', () => {
    const ref = createRef<HTMLAnchorElement>()
    render(
      <Link ref={ref} href="/x">
        x
      </Link>,
    )
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(<Link href="/x">a real link</Link>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
