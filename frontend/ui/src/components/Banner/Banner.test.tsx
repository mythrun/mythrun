import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { Severity } from '@mythrun/client-core/contract'
import { Banner } from './Banner.tsx'

// Per-severity expectations: the token border + the severity glyph + the ARIA
// announcement role. success/info announce politely (role="status"); warning/
// danger announce assertively (role="alert"). Body text is ALWAYS --ink (the §4
// rule — the severity color rides the icon/accent bar, never the body copy).
const CASES: readonly {
  severity: Severity
  role: 'status' | 'alert'
  border: string
  iconTint: string
}[] = [
  { severity: 'success', role: 'status', border: 'border-border-success', iconTint: 'text-text-success' },
  { severity: 'info', role: 'status', border: 'border-border-info', iconTint: 'text-text-info' },
  { severity: 'warning', role: 'alert', border: 'border-border-warning', iconTint: 'text-text-warning' },
  { severity: 'danger', role: 'alert', border: 'border-border-danger', iconTint: 'text-text-danger' },
]

describe('Banner', () => {
  for (const { severity, role, border, iconTint } of CASES) {
    it(`renders ${severity}: ${role} role, ${border} edge, tinted severity icon`, () => {
      render(
        <Banner severity={severity} title="banner.title">
          banner.body
        </Banner>,
      )
      const region = screen.getByRole(role)
      // The severity token border rides the box.
      expect(region).toHaveClass(border)
      // The severity icon is tinted with the status text token (icon carries the color).
      const icon = region.querySelector('svg')
      expect(icon).not.toBeNull()
      expect(icon?.parentElement).toHaveClass(iconTint)
    })

    it(`announces ${severity} as ${role} (polite vs assertive by severity)`, () => {
      render(<Banner severity={severity}>banner.body</Banner>)
      expect(screen.getByRole(role)).toBeInTheDocument()
      // The complementary role must NOT be present.
      const other = role === 'status' ? 'alert' : 'status'
      expect(screen.queryByRole(other)).not.toBeInTheDocument()
    })
  }

  it('keeps body text in --ink, NOT the status color (§4 AA rule)', () => {
    render(
      <Banner severity="danger" title="banner.title">
        banner.body
      </Banner>,
    )
    const region = screen.getByRole('alert')
    const body = screen.getByText('banner.body')
    // The body copy uses the ink token, never the danger text token.
    expect(body).toHaveClass('text-ink')
    expect(body.className).not.toContain('text-text-danger')
    // And nowhere does the body region color its text with the status token.
    expect(region.querySelector('.text-text-danger svg')).not.toBeNull() // only the ICON is tinted
  })

  it('renders the title when supplied and omits it otherwise', () => {
    const { rerender } = render(
      <Banner severity="info" title="banner.title">
        banner.body
      </Banner>,
    )
    expect(screen.getByText('banner.title')).toBeInTheDocument()
    rerender(<Banner severity="info">banner.body</Banner>)
    expect(screen.queryByText('banner.title')).not.toBeInTheDocument()
  })

  it('is NOT dismissible by default (no close control)', () => {
    render(<Banner severity="info">banner.body</Banner>)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('fires onDismiss from the labelled close control when dismissible', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <Banner severity="warning" dismissible dismissLabel="action.dismiss" onDismiss={onDismiss}>
        banner.body
      </Banner>,
    )
    const close = screen.getByRole('button', { name: 'action.dismiss' })
    await user.click(close)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Banner ref={ref} severity="success">
        banner.body
      </Banner>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (each severity)', async () => {
    for (const { severity } of CASES) {
      const { container, unmount } = render(
        <Banner severity={severity} title="banner.title" dismissible dismissLabel="action.dismiss">
          banner.body
        </Banner>,
      )
      expect(await axe(container)).toHaveNoViolations()
      unmount()
    }
  })
})
