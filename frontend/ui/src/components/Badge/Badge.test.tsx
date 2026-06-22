import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { BadgeVariant } from '@mythrun/client-core/contract'
import { Badge } from './Badge.tsx'

// Per-variant token expectations. neutral is the quiet brand chip
// (--surface / --ink / --border-strong); the four severities reuse the §4
// status-intent triad (a --surface-{intent} tint + the AA --text-{intent} ink).
const CASES: readonly { variant: BadgeVariant; surface: string; text: string }[] = [
  { variant: 'neutral', surface: 'bg-surface', text: 'text-ink' },
  { variant: 'success', surface: 'bg-surface-success', text: 'text-text-success' },
  { variant: 'warning', surface: 'bg-surface-warning', text: 'text-text-warning' },
  { variant: 'danger', surface: 'bg-surface-danger', text: 'text-text-danger' },
  { variant: 'info', surface: 'bg-surface-info', text: 'text-text-info' },
]

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>badge.label</Badge>)
    expect(screen.getByText('badge.label')).toBeInTheDocument()
  })

  it('defaults to the neutral variant', () => {
    render(<Badge>label</Badge>)
    const chip = screen.getByText('label')
    expect(chip).toHaveClass('bg-surface')
    expect(chip).toHaveClass('text-ink')
  })

  for (const { variant, surface, text } of CASES) {
    it(`applies the ${variant} token triad`, () => {
      render(<Badge variant={variant}>label</Badge>)
      const chip = screen.getByText('label')
      expect(chip).toHaveClass(surface)
      expect(chip).toHaveClass(text)
    })
  }

  it('is flat (rounded-none) and mono (font-ui)', () => {
    render(<Badge>label</Badge>)
    const chip = screen.getByText('label')
    expect(chip).toHaveClass('rounded-none')
    expect(chip).toHaveClass('font-ui')
  })

  it('carries no implicit ARIA role (the text carries the meaning)', () => {
    render(<Badge variant="danger">3</Badge>)
    // A bare chip — no status/alert role is asserted (color is reinforcement).
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Badge ref={ref}>label</Badge>)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no axe violations (each variant)', async () => {
    for (const { variant } of CASES) {
      const { container, unmount } = render(<Badge variant={variant}>label</Badge>)
      expect(await axe(container)).toHaveNoViolations()
      unmount()
    }
  })
})
