import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { RosterMember } from '@mythrun/client-core/contract'
import { PartyRoster } from './PartyRoster.tsx'

// Solo — one real (ready) member who is the viewer, plus the synthetic `empty`
// invite slot (the common launch case the mockup calls out).
const SOLO: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm', status: 'ready', isViewer: true },
  { userId: 'invite', displayName: '', status: 'empty', isViewer: false },
]

// A full party: the viewer (ready), another ready player, and a laggard still
// creating (no characterName yet → renders the status prose sub-line).
const PARTY: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Ordric', characterName: 'Ordric Vane', status: 'ready', isViewer: false },
  { userId: 'u3', displayName: 'Pell', status: 'creating', isViewer: false },
]

// A party with a just-joined member: the owner (ready) plus a real teammate who has
// joined but not started a character yet (`gathering` — NOT the invite slot).
const GATHERING: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Bree', status: 'gathering', isViewer: false },
]

const noop = (): void => undefined

// The resolved chrome labels the shell supplies (real MYT-100 copy). The
// partial-begin strings arrive count-resolved (the shell interpolates).
const LABELS = {
  partyHeading: 'Your party',
  inviteSub: 'Share a link · they join here',
  creating: 'Choosing who they are…',
  gathering: 'Just joined, making their character…',
  waiting: 'Waiting for the party to gather…',
  beginSolo: 'Begin the adventure →',
  beginParty: "Everyone's ready, begin →",
  beginPartial: 'Begin with 2 of 3 ready →',
  beginConfirmPrompt: "1 player isn't ready. Start anyway?",
  beginConfirmYes: 'Start anyway',
  beginConfirmNo: 'Keep waiting',
}

// Everyone ready — the full-party direct-begin case.
const READY_PARTY: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Ordric', characterName: 'Ordric Vane', status: 'ready', isViewer: false },
]

describe('PartyRoster', () => {
  it('renders a row per member with the displayName and the ready character name', () => {
    const { getByText, getAllByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // One member row per real member (the empty invite row is a distinct node).
    expect(getAllByTestId('party-roster-member')).toHaveLength(3)
    // Miklos is the viewer, so the name line also carries the "· you" marker.
    expect(getByText(/Miklos/)).toBeInTheDocument()
    expect(getByText('Ordric')).toBeInTheDocument()
    expect(getByText('Pell')).toBeInTheDocument()
    // A ready member's characterName is the sub-line.
    expect(getByText('Kessa Vurm')).toBeInTheDocument()
    expect(getByText('Ordric Vane')).toBeInTheDocument()
  })

  it('marks the viewer with a "you" marker (prose, not a dot)', () => {
    const { getByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getByTestId('party-roster-you')).toHaveTextContent(/you/i)
  })

  it('shows the status prose sub-line for a still-creating member (no characterName)', () => {
    const { getByText, queryByText } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Pell has no characterName → the "choosing who they are" prose stands in.
    expect(getByText(/choosing who they are/i)).toBeInTheDocument()
    // And a mono "creating" marker (as prose, not a chip).
    expect(getByText(/creating/i)).toBeInTheDocument()
    // Pell shows no character name (there is none yet).
    expect(queryByText('Pell Vane')).not.toBeInTheDocument()
  })

  it('shows a "ready" status marker as prose for ready members', () => {
    const { getAllByText } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getAllByText(/^ready$/i).length).toBeGreaterThan(0)
  })

  it('renders a gathering member as a real member row (not the invite slot) with the gathering marker', () => {
    const { getByText, getAllByTestId, queryByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Bree is a real teammate, so she renders as a member row — NOT the dashed
    // invite affordance (the bug this split fixes).
    expect(getAllByTestId('party-roster-member')).toHaveLength(2)
    expect(queryByTestId('party-roster-invite')).not.toBeInTheDocument()
    expect(getByText('Bree')).toBeInTheDocument()
    // The gathering member shows the joined-not-started stand-in sub-line…
    expect(getByText(/just joined/i)).toBeInTheDocument()
    // …and a terse "gathering…" marker (prose, not a chip).
    expect(getByText(/gathering/i)).toBeInTheDocument()
  })

  it('counts a gathering member as a real member in the party label', () => {
    const { getByText } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Owner (ready) + Bree (gathering) are both real → the panel reads "(2)".
    expect(getByText(/your party \(2\)/i)).toBeInTheDocument()
  })

  it('conveys the gathering status as prose text, never a dot/chip/badge', () => {
    const { getAllByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    for (const marker of getAllByTestId('party-roster-status')) {
      expect(marker.className).not.toMatch(/border/)
      expect(marker.className).not.toMatch(/\bbg-/)
    }
  })

  it('renders the empty status as a dashed invite row that fires onInvite', async () => {
    const onInvite = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={onInvite} />,
    )
    const invite = getByTestId('party-roster-invite')
    expect(invite.tagName).toBe('BUTTON')
    expect(invite.className).toMatch(/border-dashed/)
    await user.click(invite)
    expect(onInvite).toHaveBeenCalledOnce()
  })

  it('fires onInvite on keyboard activation (real button)', async () => {
    const onInvite = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={onInvite} />,
    )
    getByTestId('party-roster-invite').focus()
    await user.keyboard('{Enter}')
    expect(onInvite).toHaveBeenCalledOnce()
  })

  it('renders the invite disclosure between the roster and Begin when provided (single entry point)', () => {
    const { getByTestId, getByRole } = render(
      <PartyRoster
        labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop}
        members={SOLO}
        viewerIsOwner
        canBegin
        onBegin={noop}
        onInvite={noop}
        inviteExpansion={<div data-testid="wired-invite" />}
      />,
    )
    // The disclosure mounts (the single invite entry point, below the party)…
    const expansion = getByTestId('party-roster-invite-expansion')
    expect(expansion).toContainElement(getByTestId('wired-invite'))
    // …and it sits BEFORE the Begin control in DOM order (below identity, above CTA).
    const begin = getByRole('button', { name: /adventure/i })
    expect(expansion.compareDocumentPosition(begin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('omits the invite disclosure when no expansion is supplied', () => {
    const { queryByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(queryByTestId('party-roster-invite-expansion')).not.toBeInTheDocument()
  })

  it('counts only real members in the party label (the invite row is excluded)', () => {
    const { getByText } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Two entries, one of them the empty invite slot → the panel reads "(1)".
    expect(getByText(/your party \(1\)/i)).toBeInTheDocument()
  })

  it('shows the Begin control only to the owner, and fires onBegin when enabled', async () => {
    const onBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={onBegin} onInvite={noop} />,
    )
    const begin = getByRole('button', { name: /begin/i })
    expect(begin).toBeEnabled()
    await user.click(begin)
    expect(onBegin).toHaveBeenCalledOnce()
  })

  it('uses the solo begin label for a one-member party and the party label when everyone is ready', () => {
    const solo = render(<PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(solo.getByRole('button', { name: /adventure/i })).toBeInTheDocument()

    const party = render(<PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={READY_PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(party.getByRole('button', { name: /everyone/i })).toBeInTheDocument()
  })

  // ux-run2 myth-wfgfi: the not-ready CTA is never a silent gray-out — the label
  // carries the truth and a single inline confirm guards the partial start.
  it('carries the partial truth on the label and only ARMS the confirm while members are not ready', async () => {
    const onBegin = vi.fn()
    const onRequestBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={onRequestBegin} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={onBegin} onInvite={noop} />,
    )
    const begin = getByRole('button', { name: /2 of 3 ready/i })
    expect(begin).toBeEnabled()
    await user.click(begin)
    expect(onRequestBegin).toHaveBeenCalledOnce()
    expect(onBegin).not.toHaveBeenCalled()
  })

  it('renders the inline partial-begin confirm when beginConfirming — confirm begins, dismiss cancels', async () => {
    const onBegin = vi.fn()
    const onCancelBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole, getByText } = render(
      <PartyRoster labels={LABELS} beginConfirming onRequestBegin={noop} onCancelBegin={onCancelBegin} members={PARTY} viewerIsOwner canBegin onBegin={onBegin} onInvite={noop} />,
    )
    expect(getByText("1 player isn't ready. Start anyway?")).toBeInTheDocument()
    await user.click(getByRole('button', { name: /keep waiting/i }))
    expect(onCancelBegin).toHaveBeenCalledOnce()
    expect(onBegin).not.toHaveBeenCalled()
    await user.click(getByRole('button', { name: /start anyway/i }))
    expect(onBegin).toHaveBeenCalledOnce()
  })

  // ux-run2 myth-wfgfi: the fiction leads — a made character's name is the serif
  // primary line; the account demotes to the mono secondary line beneath it.
  it('leads a made member row with the character name and demotes the account to the sub-line', () => {
    const { getAllByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    const rows = getAllByTestId('party-roster-member')
    const kessaRow = rows[0]
    if (!kessaRow) throw new Error('no rows')
    const primary = kessaRow.querySelector('.font-body')
    const secondary = kessaRow.querySelector('.font-ui')
    expect(primary?.textContent).toContain('Kessa Vurm')
    expect(secondary?.textContent).toContain('Miklos')
    // A member with no character yet keeps the account name as the primary line.
    const pellRow = rows[2]
    if (!pellRow) throw new Error('no third row')
    expect(pellRow.querySelector('.font-body')?.textContent).toContain('Pell')
  })

  // ux-run2 myth-5dobj: the placeholder recedes, the person holds the ink —
  // the ghost invite row is transparent (dashed border only), and READY carries
  // solid-ink state weight while the waiting states stay halftone.
  it('recedes the ghost invite row (transparent) and gives ready solid ink', () => {
    const { getByTestId, getAllByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getByTestId('party-roster-invite').className).toContain('bg-transparent')
    const [readyMarker] = getAllByTestId('party-roster-status')
    expect(readyMarker?.className).toContain('text-ink')
    expect(readyMarker?.className).toContain('font-semibold')
  })

  it('disables Begin when the party is not finalizable, and swallows the press', async () => {
    const onBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin={false} onBegin={onBegin} onInvite={noop} />,
    )
    const begin = getByRole('button', { name: /begin/i })
    expect(begin).toBeDisabled()
    await user.click(begin)
    expect(onBegin).not.toHaveBeenCalled()
  })

  it('shows a waiting line (not the Begin control) to a non-owner member', () => {
    const { queryByRole, getByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner={false} canBegin={false} onBegin={noop} onInvite={noop} />,
    )
    expect(queryByRole('button', { name: /begin/i })).not.toBeInTheDocument()
    expect(getByTestId('party-roster-waiting')).toBeInTheDocument()
  })

  it('conveys status as prose text, never a dot/chip/badge (no borders/fills, no circles)', () => {
    const { getAllByTestId, container } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Every status marker is plain mono text — no bordered/filled pill.
    for (const marker of getAllByTestId('party-roster-status')) {
      expect(marker.className).not.toMatch(/border/)
      expect(marker.className).not.toMatch(/\bbg-/)
    }
    // Nowhere in the surface is a circle/dot (rounded-full is banned).
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('is flat 1-bit / square (member rows carry rounded-none, no circles)', () => {
    const { getAllByTestId } = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    for (const row of getAllByTestId('party-roster-member')) {
      expect(row.className).toContain('rounded-none')
    }
  })

  it('carries a data-testid on the root and forwards the ref', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(
      <PartyRoster ref={ref} labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getByTestId('party-roster')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (owner solo, and non-owner party)', async () => {
    const owner = render(<PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(await axe(owner.container)).toHaveNoViolations()
    const member = render(
      <PartyRoster labels={LABELS} beginConfirming={false} onRequestBegin={noop} onCancelBegin={noop} members={PARTY} viewerIsOwner={false} canBegin={false} onBegin={noop} onInvite={noop} />,
    )
    expect(await axe(member.container)).toHaveNoViolations()
  })
})
