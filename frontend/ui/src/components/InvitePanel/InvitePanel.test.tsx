import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { InvitePanelProps } from '@mythrun/client-core/contract'
import { InvitePanel } from './InvitePanel.tsx'

// A ready panel: a live primary link, share available, nothing pending. Each test
// overrides the slice of props it exercises.
// The resolved chrome copy the shell supplies (real MYT-100 campaign.invite.* copy).
const LABELS: InvitePanelProps['labels'] = {
  panelHeading: 'Invite',
  hint: 'Share this link · friends join your party here',
  loading: 'Preparing your invite link…',
  noLink: 'No active link, create one to invite',
  linkLabel: 'Invite link',
  create: 'Create a link',
  copy: 'Copy link',
  copied: 'Copied',
  share: 'Share',
  replace: 'Replace link',
  limit: "You've reached the invite limit. Replace the existing link instead.",
  error: 'Something went wrong. Try again.',
}

const READY: InvitePanelProps = {
  labels: LABELS,
  inviteUrl: 'https://mythrun.com/join/ABC123',
  loading: false,
  canShare: true,
  copied: false,
  notice: null,
  onCopy: (): void => undefined,
  onShare: (): void => undefined,
  onRevoke: (): void => undefined,
  onCreate: (): void => undefined,
}

function renderPanel(overrides: Partial<InvitePanelProps> = {}) {
  return render(<InvitePanel {...READY} {...overrides} />)
}

describe('InvitePanel', () => {
  it('renders the invite link read-only and fires onCopy on the copy control', async () => {
    const onCopy = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = renderPanel({ onCopy })
    // The link shows verbatim as a NON-editable field (a route owns clipboard).
    const link = getByTestId('invite-panel-link')
    expect(link).toHaveValue('https://mythrun.com/join/ABC123')
    expect(link).toHaveAttribute('readonly')
    // Copy is a neutral callback — the panel never touches navigator.clipboard.
    await user.click(getByTestId('invite-panel-copy'))
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('shows the share control ONLY when canShare, and fires onShare', async () => {
    const onShare = vi.fn()
    const user = userEvent.setup()
    const { getByTestId, queryByTestId, rerender } = render(
      <InvitePanel {...READY} canShare onShare={onShare} />,
    )
    await user.click(getByTestId('invite-panel-share'))
    expect(onShare).toHaveBeenCalledOnce()

    // No native share on this platform → no share affordance at all.
    rerender(<InvitePanel {...READY} canShare={false} onShare={onShare} />)
    expect(queryByTestId('invite-panel-share')).not.toBeInTheDocument()
  })

  it('fires onRevoke from the replace-link control', async () => {
    const onRevoke = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = renderPanel({ onRevoke })
    await user.click(getByTestId('invite-panel-revoke'))
    expect(onRevoke).toHaveBeenCalledOnce()
  })

  it('shows a calm loading line and NO link while loading', () => {
    const { getByTestId, queryByTestId } = renderPanel({ loading: true, inviteUrl: null })
    expect(getByTestId('invite-panel-loading')).toBeInTheDocument()
    // No link field, no copy/share/revoke while the link is still resolving.
    expect(queryByTestId('invite-panel-link')).not.toBeInTheDocument()
    expect(queryByTestId('invite-panel-copy')).not.toBeInTheDocument()
  })

  it('offers a create affordance (firing onCreate) when there is no link and not loading', async () => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    const { getByTestId, queryByTestId } = renderPanel({ inviteUrl: null, loading: false, onCreate })
    // Post-revoke with no fresh link: the panel offers to mint one, not a dead field.
    expect(queryByTestId('invite-panel-link')).not.toBeInTheDocument()
    await user.click(getByTestId('invite-panel-create'))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('renders a calm Banner for the cap-reached notice', () => {
    const { getByTestId } = renderPanel({ notice: 'cap-reached' })
    expect(getByTestId('invite-panel-notice')).toBeInTheDocument()
  })

  it('renders a calm Banner for the error notice', () => {
    const { getByTestId } = renderPanel({ notice: 'error' })
    expect(getByTestId('invite-panel-notice')).toBeInTheDocument()
  })

  it('renders no notice Banner when notice is null', () => {
    const { queryByTestId } = renderPanel({ notice: null })
    expect(queryByTestId('invite-panel-notice')).not.toBeInTheDocument()
  })

  it('swaps the copy control to a copied acknowledgement when copied is true', () => {
    const { getByTestId, rerender } = render(<InvitePanel {...READY} copied={false} />)
    const copy = getByTestId('invite-panel-copy')
    expect(copy).toHaveTextContent(/^copy/i)

    rerender(<InvitePanel {...READY} copied />)
    expect(getByTestId('invite-panel-copy')).toHaveTextContent(/copied/i)
  })

  it('conveys state as prose/fields, never a status dot/chip/circle', () => {
    const { container } = renderPanel({ notice: 'cap-reached' })
    // Register rule: no circles anywhere (rounded-full is banned brand-wide).
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('carries a data-testid on the root and forwards the ref', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(<InvitePanel ref={ref} {...READY} />)
    expect(getByTestId('invite-panel')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (ready, loading, no-link, and notice states)', async () => {
    const ready = renderPanel()
    expect(await axe(ready.container)).toHaveNoViolations()

    const loading = renderPanel({ loading: true, inviteUrl: null })
    expect(await axe(loading.container)).toHaveNoViolations()

    const noLink = renderPanel({ inviteUrl: null, loading: false })
    expect(await axe(noLink.container)).toHaveNoViolations()

    const notice = renderPanel({ notice: 'error' })
    expect(await axe(notice.container)).toHaveNoViolations()
  })
})
