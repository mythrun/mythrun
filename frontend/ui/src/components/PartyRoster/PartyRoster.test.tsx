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

// The resolved chrome labels the shell supplies (real MYT-100 copy).
const LABELS = {
  partyHeading: 'Your party',
  inviteSub: 'share a link · they join here',
  creating: 'choosing who they are…',
  gathering: 'just joined, making their character…',
  waiting: 'waiting for the party to gather…',
  beginSolo: 'begin the adventure →',
  beginParty: "everyone's ready, begin →",
}

describe('PartyRoster', () => {
  it('renders a row per member with the displayName and the ready character name', () => {
    const { getByText, getAllByTestId } = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
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
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getByTestId('party-roster-you')).toHaveTextContent(/you/i)
  })

  it('shows the status prose sub-line for a still-creating member (no characterName)', () => {
    const { getByText, queryByText } = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
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
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getAllByText(/^ready$/i).length).toBeGreaterThan(0)
  })

  it('renders a gathering member as a real member row (not the invite slot) with the gathering marker', () => {
    const { getByText, getAllByTestId, queryByTestId } = render(
      <PartyRoster labels={LABELS} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
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
      <PartyRoster labels={LABELS} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Owner (ready) + Bree (gathering) are both real → the panel reads "(2)".
    expect(getByText(/your party \(2\)/i)).toBeInTheDocument()
  })

  it('conveys the gathering status as prose text, never a dot/chip/badge', () => {
    const { getAllByTestId } = render(
      <PartyRoster labels={LABELS} members={GATHERING} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
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
      <PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={onInvite} />,
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
      <PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={onInvite} />,
    )
    getByTestId('party-roster-invite').focus()
    await user.keyboard('{Enter}')
    expect(onInvite).toHaveBeenCalledOnce()
  })

  it('counts only real members in the party label (the invite row is excluded)', () => {
    const { getByText } = render(
      <PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    // Two entries, one of them the empty invite slot → the panel reads "(1)".
    expect(getByText(/your party \(1\)/i)).toBeInTheDocument()
  })

  it('shows the Begin control only to the owner, and fires onBegin when enabled', async () => {
    const onBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={onBegin} onInvite={noop} />,
    )
    const begin = getByRole('button', { name: /begin/i })
    expect(begin).toBeEnabled()
    await user.click(begin)
    expect(onBegin).toHaveBeenCalledOnce()
  })

  it('uses the solo begin label for a one-member party and the party label otherwise', () => {
    const solo = render(<PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(solo.getByRole('button', { name: /adventure/i })).toBeInTheDocument()

    const party = render(<PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(party.getByRole('button', { name: /everyone/i })).toBeInTheDocument()
  })

  it('disables Begin when the party is not finalizable, and swallows the press', async () => {
    const onBegin = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin={false} onBegin={onBegin} onInvite={noop} />,
    )
    const begin = getByRole('button', { name: /begin/i })
    expect(begin).toBeDisabled()
    await user.click(begin)
    expect(onBegin).not.toHaveBeenCalled()
  })

  it('shows a waiting line (not the Begin control) to a non-owner member', () => {
    const { queryByRole, getByTestId } = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner={false} canBegin={false} onBegin={noop} onInvite={noop} />,
    )
    expect(queryByRole('button', { name: /begin/i })).not.toBeInTheDocument()
    expect(getByTestId('party-roster-waiting')).toBeInTheDocument()
  })

  it('conveys status as prose text, never a dot/chip/badge (no borders/fills, no circles)', () => {
    const { getAllByTestId, container } = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
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
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    for (const row of getAllByTestId('party-roster-member')) {
      expect(row.className).toContain('rounded-none')
    }
  })

  it('carries a data-testid on the root and forwards the ref', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(
      <PartyRoster ref={ref} labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />,
    )
    expect(getByTestId('party-roster')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (owner solo, and non-owner party)', async () => {
    const owner = render(<PartyRoster labels={LABELS} members={SOLO} viewerIsOwner canBegin onBegin={noop} onInvite={noop} />)
    expect(await axe(owner.container)).toHaveNoViolations()
    const member = render(
      <PartyRoster labels={LABELS} members={PARTY} viewerIsOwner={false} canBegin={false} onBegin={noop} onInvite={noop} />,
    )
    expect(await axe(member.container)).toHaveNoViolations()
  })
})
