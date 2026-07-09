import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineLink } from './InlineLink.tsx'

// InlineLink is the SCAFFOLD for in-prose entity mentions (plan §8.1: dropped
// for v1 — the wiki body does NOT auto-linkify; RELATED carries navigation).
// The component exists so a future marked-mention pipeline has a ready render
// affordance. Behavior is minimal: a native inline button that navigates.

describe('InlineLink', () => {
  it('renders the mention text as a native button and navigates on activation', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <InlineLink entityId="n-vale" onNavigate={onNavigate}>
        Maeris Vale
      </InlineLink>,
    )
    const link = getByRole('button', { name: 'Maeris Vale' })
    await user.click(link)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('n-vale')
  })

  it('is keyboard operable (native button semantics)', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <InlineLink entityId="l-ward" onNavigate={onNavigate}>
        The Drowned Ward
      </InlineLink>,
    )
    getByRole('button', { name: 'The Drowned Ward' }).focus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('l-ward')
  })
})
