import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { JoinPreviewProps, AcceptArmKind } from '@mythrun/client-core/contract'
import { JoinPreview } from './JoinPreview.tsx'

const noop = (): void => undefined

// The resolved chrome copy the shell supplies (real MYT-100 join.preview.* copy).
const LABELS: JoinPreviewProps['labels'] = {
  eyebrow: "You've been invited",
  invitedBy: 'Invited by',
  accept: 'Accept the invitation →',
  signin: 'Sign in to join →',
  invalid: 'This invite is no longer valid.',
  full: 'This campaign is already full.',
  revoked: 'This invite link was turned off.',
  gone: 'This campaign is no longer available.',
  notFound: "That invite doesn't lead anywhere.",
  timeout: 'That took too long. Try again.',
  error: 'Something went wrong. Try again.',
}

// The common case: a valid, signed-in preview ready to accept. Each test overrides
// the axis it exercises. Names are realistic samples (tests are lint-exempt).
function baseProps(overrides: Partial<JoinPreviewProps> = {}): JoinPreviewProps {
  return {
    labels: LABELS,
    campaignName: 'The Sunless Reach',
    ownerName: 'Miklos',
    valid: true,
    signedIn: true,
    accepting: false,
    arm: null,
    onAccept: noop,
    onSignIn: noop,
    ...overrides,
  }
}

// Every post-accept calm-notice arm (matches AcceptArmKind verbatim).
const ARMS: AcceptArmKind[] = ['full', 'revoked', 'gone', 'not-found', 'timeout', 'error']

describe('JoinPreview', () => {
  it('renders the campaign name and the inviting owner', () => {
    const { getByTestId } = render(<JoinPreview {...baseProps()} />)
    expect(getByTestId('join-preview-campaign')).toHaveTextContent('The Sunless Reach')
    expect(getByTestId('join-preview-owner')).toHaveTextContent('Miklos')
  })

  it('renders the campaign name in the serif title register (a real heading)', () => {
    const { getByRole } = render(<JoinPreview {...baseProps()} />)
    expect(getByRole('heading', { name: 'The Sunless Reach' })).toBeInTheDocument()
  })

  it('shows the accept CTA (firing onAccept), not the sign-in CTA, when signed in', async () => {
    const onAccept = vi.fn()
    const user = userEvent.setup()
    const { getByTestId, queryByTestId } = render(<JoinPreview {...baseProps({ signedIn: true, onAccept })} />)
    expect(queryByTestId('join-preview-signin')).not.toBeInTheDocument()
    await user.click(getByTestId('join-preview-accept'))
    expect(onAccept).toHaveBeenCalledOnce()
  })

  it('shows the sign-in CTA (firing onSignIn), not the accept CTA, when signed out', async () => {
    const onSignIn = vi.fn()
    const user = userEvent.setup()
    const { getByTestId, queryByTestId } = render(<JoinPreview {...baseProps({ signedIn: false, onSignIn })} />)
    expect(queryByTestId('join-preview-accept')).not.toBeInTheDocument()
    await user.click(getByTestId('join-preview-signin'))
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('renders the calm invalid notice with the real campaign/owner and NO CTA when not valid', () => {
    const { getByTestId, queryByTestId } = render(<JoinPreview {...baseProps({ valid: false, signedIn: true })} />)
    // The revoked/expired 200 state still shows the real world data (not a 404) …
    expect(getByTestId('join-preview-campaign')).toHaveTextContent('The Sunless Reach')
    expect(getByTestId('join-preview-owner')).toHaveTextContent('Miklos')
    // … under a calm notice, and neither CTA is offered (nothing to accept).
    expect(getByTestId('join-preview-notice')).toBeInTheDocument()
    expect(queryByTestId('join-preview-accept')).not.toBeInTheDocument()
    expect(queryByTestId('join-preview-signin')).not.toBeInTheDocument()
  })

  it('shows a busy, non-interactive accept CTA while accepting (swallows the press)', async () => {
    const onAccept = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = render(<JoinPreview {...baseProps({ accepting: true, onAccept })} />)
    const accept = getByTestId('join-preview-accept')
    expect(accept).toBeDisabled()
    expect(accept).toHaveAttribute('aria-busy', 'true')
    await user.click(accept)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('renders a distinct calm notice for every post-accept arm', () => {
    const lines = ARMS.map((arm) => {
      const { getByTestId, unmount } = render(<JoinPreview {...baseProps({ arm })} />)
      const notice = getByTestId('join-preview-notice')
      expect(notice).toBeInTheDocument()
      const text = notice.textContent
      expect(text.length).toBeGreaterThan(0)
      unmount()
      return text
    })
    // Each arm maps to its OWN line — no two arms collapse to the same notice.
    expect(new Set(lines).size).toBe(ARMS.length)
  })

  it('keeps the accept CTA available under a post-accept arm (the route owns retry / navigation)', () => {
    const { getByTestId } = render(<JoinPreview {...baseProps({ arm: 'timeout', signedIn: true })} />)
    expect(getByTestId('join-preview-notice')).toBeInTheDocument()
    expect(getByTestId('join-preview-accept')).toBeInTheDocument()
  })

  it('is flat 1-bit / square — no circles anywhere', () => {
    const { container } = render(<JoinPreview {...baseProps()} />)
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('carries a data-testid on the root and forwards the ref', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(<JoinPreview ref={ref} {...baseProps()} />)
    expect(getByTestId('join-preview')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (signed-in, signed-out, invalid, and an arm notice)', async () => {
    const signedIn = render(<JoinPreview {...baseProps({ signedIn: true })} />)
    expect(await axe(signedIn.container)).toHaveNoViolations()
    signedIn.unmount()

    const signedOut = render(<JoinPreview {...baseProps({ signedIn: false })} />)
    expect(await axe(signedOut.container)).toHaveNoViolations()
    signedOut.unmount()

    const invalid = render(<JoinPreview {...baseProps({ valid: false })} />)
    expect(await axe(invalid.container)).toHaveNoViolations()
    invalid.unmount()

    const armed = render(<JoinPreview {...baseProps({ arm: 'full' })} />)
    expect(await axe(armed.container)).toHaveNoViolations()
  })
})
