import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  HttpError,
  createSseStatusClient,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
  type CharacterFull,
  type SseStatusClient,
} from '@mythrun/client-core'
import type { PipelineEvent } from '@mythrun/contract/events'
import { i18n } from '../../i18n/config.ts'
import { PartyStagingSurface, type PartyStagingDeps } from './party-staging.tsx'
import type { InvitePanelDeps } from '../campaign-invite-panel.tsx'

// A happy-path invite seam — resolves a fixed primary link so the inline disclosure
// (opened from the dashed slot) renders the link without a live endpoint.
const INVITE_DEPS: InvitePanelDeps = {
  ensurePrimary: () => Promise.resolve({ inviteUrl: 'https://mythrun.com/join/PARTY', inviteCode: 'PARTY' }),
  create: () => Promise.resolve({ inviteUrl: 'https://mythrun.com/join/PARTY', inviteCode: 'PARTY' }),
  revoke: () => Promise.resolve(),
  copyText: () => Promise.resolve(),
  webShare: () => Promise.resolve(),
  canShare: true,
}

// The PARTY-STAGING SURFACE (MYT-90 D7) — the "ready to begin?" screen D8 mounts
// once the viewer's own character is confirmed. It composes the DS <PartyRoster>
// over the committed client-core view-model: it FETCHES the roster progress +
// the viewer's owner role (the `getMyCampaigns → creator === null` mechanism the
// other routes use), maps progress → roster rows, and wires the owner-only Begin
// (finalize → onFinalized). Invite is the MYT-91 boundary — a no-op seam here.
//
// These inject the three endpoint seams through the `deps` object (defaults are
// the real endpoints) and assert each path: owner sees the roster + an enabled
// Begin; a non-owner sees the waiting line; Begin finalizes then re-routes; the
// solo case carries the invite row. ApiClientProvider carries the ctx; i18n
// serves the real catalog.

const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const CID = 'camp-1'
const OWNER = 'user-owner'
const MEMBER = 'user-member'

/** A full, valid CampaignSummary with the fields the surface reads (creator +
 *  party) overridable; the rest are inert defaults. */
function campaign(over: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: CID,
    worldId: 'world-1',
    name: 'The Hollow Road',
    status: 'setup',
    language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    worldName: 'Aldermoor',
    worldColors: null,
    creator: null,
    party: [{ userId: OWNER, displayName: 'Kessa', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'needs-character',
    ...over,
  }
}

function progress(over: Partial<CharacterCreationProgress> = {}): CharacterCreationProgress {
  return {
    campaignId: CID,
    totalMembers: 1,
    concepts: [{ userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' }],
    missing: [],
    ...over,
  }
}

interface Opts {
  readonly viewerUserId?: string
  readonly deps?: PartyStagingDeps
  readonly inviteDeps?: InvitePanelDeps
  readonly onFinalized?: () => void
}

/** A hand-driven status-SSE client: the test pushes `PipelineEvent`s the live
 *  roster folds. It borrows a real (never-opened) connection store and no-ops the
 *  rest; `createClient` is a STABLE reference (the live-roster SSE effect re-runs if
 *  it changes). Mirrors the campaign-page test's driver. */
function makeDriver(): {
  createClient: NonNullable<PartyStagingDeps['createClient']>
  emit: (e: PipelineEvent) => void
} {
  const eventCbs = new Set<(e: PipelineEvent) => void>()
  const { connectionState } = createSseStatusClient(testCtx)
  const client: SseStatusClient = {
    open: () => undefined,
    onEvent: (cb) => {
      eventCbs.add(cb)
      return () => {
        eventCbs.delete(cb)
      }
    },
    onSnapshot: () => () => undefined,
    connectionState,
    close: () => undefined,
  }
  return {
    createClient: () => client,
    emit: (e) => {
      for (const cb of eventCbs) cb(e)
    },
  }
}

/** A full raw character read carrying the one field the surface uses (the NAME);
 *  the rest are inert, schema-complete defaults. */
function characterFull(name: string): CharacterFull {
  return {
    character: {
      id: 'char-1',
      user_id: OWNER,
      entity_id: null,
      name,
      level: 3,
      class: 'Cleric',
      species: 'Human',
      background: 'Hermit',
      str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 12,
      hit_points: 21, max_hit_points: 21, armor_class: 15,
      proficiency_bonus: 2, gold: 15, hit_die: 8, hit_dice_remaining: 3,
      spellcasting_progression: 'full',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    skills: [], features: [], equipment: [], spells: [],
  }
}

/** Resolve a full deps object from partial overrides — every seam defaults to a
 *  happy-path mock so a test only names the seam it cares about. */
function resolveDeps(deps: PartyStagingDeps = {}): Required<PartyStagingDeps> {
  return {
    getProgress: deps.getProgress ?? vi.fn().mockResolvedValue(progress()),
    finalize: deps.finalize ?? vi.fn().mockResolvedValue({ campaignId: CID, jobId: 'job-1' }),
    getCampaigns: deps.getCampaigns ?? vi.fn().mockResolvedValue([campaign()]),
    // A quiet default transport (never emits, never connects) so the roster is
    // static unless a test drives its own driver.
    createClient: deps.createClient ?? makeDriver().createClient,
    // The default fixtures carry no characterId, so the name read never fires;
    // a rejecting default keeps any unexpected call calm (the hook degrades).
    getCharacter: deps.getCharacter ?? vi.fn().mockRejectedValue(new Error('not fixtured')),
  }
}

function renderSurface({ viewerUserId = OWNER, deps, inviteDeps, onFinalized = vi.fn() }: Opts = {}): {
  deps: Required<PartyStagingDeps>
  onFinalized: () => void
} {
  const resolved = resolveDeps(deps)
  render(
    <ApiClientProvider value={testCtx}>
      <I18nextProvider i18n={i18n}>
        <PartyStagingSurface
          campaignId={CID}
          viewerUserId={viewerUserId}
          onFinalized={onFinalized}
          deps={resolved}
          {...(inviteDeps !== undefined && { inviteDeps })}
        />
      </I18nextProvider>
    </ApiClientProvider>,
  )
  return { deps: resolved, onFinalized }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PartyStagingSurface — owner', () => {
  it('shows the roster and an ENABLED Begin when the owner concept is ready', async () => {
    renderSurface({ viewerUserId: OWNER })
    await screen.findByTestId('party-staging')
    const begin = await screen.findByRole('button', { name: /begin/i })
    expect((begin as HTMLButtonElement).disabled).toBe(false)
    // Owner view — the finalize control, never the member waiting line.
    expect(screen.queryByTestId('party-roster-waiting')).toBeNull()
  })

  it('Begin finalizes then calls onFinalized', async () => {
    const finalize = vi.fn().mockResolvedValue({ campaignId: CID, jobId: 'job-1' })
    const { onFinalized } = renderSurface({ viewerUserId: OWNER, deps: { finalize } })
    fireEvent.click(await screen.findByRole('button', { name: /begin/i }))
    await waitFor(() => {
      expect(onFinalized).toHaveBeenCalledTimes(1)
    })
    expect(finalize).toHaveBeenCalledWith(expect.anything(), CID)
  })

  it('keeps the roster up with a calm note when Begin fails (no onFinalized)', async () => {
    const finalize = vi.fn().mockRejectedValue(new HttpError(409, 'Conflict', 'not_in_setup'))
    const { onFinalized } = renderSurface({ viewerUserId: OWNER, deps: { finalize } })
    fireEvent.click(await screen.findByRole('button', { name: /begin/i }))
    await screen.findByTestId('party-staging-begin-error')
    expect(onFinalized).not.toHaveBeenCalled()
    expect(screen.getByTestId('party-staging')).toBeDefined()
  })
})

describe('PartyStagingSurface — solo + party shape', () => {
  it('solo owner carries one member row + the invite row', async () => {
    renderSurface({ viewerUserId: OWNER })
    await screen.findByTestId('party-staging')
    expect(screen.getAllByTestId('party-roster-member')).toHaveLength(1)
    expect(screen.getByTestId('party-roster-invite')).toBeDefined()
  })

  it('opens the inline invite disclosure from the dashed slot (single entry point, no block above)', async () => {
    renderSurface({ viewerUserId: OWNER, inviteDeps: INVITE_DEPS })
    await screen.findByTestId('party-staging')
    // Collapsed by default — the dashed slot is present, no invite panel yet.
    expect(screen.queryByTestId('party-roster-invite-expansion')).toBeNull()
    fireEvent.click(screen.getByTestId('party-roster-invite'))
    // Opening reveals the wired invite INLINE (below the party, above Begin).
    const expansion = await screen.findByTestId('party-roster-invite-expansion')
    const link = await screen.findByTestId('invite-panel-link')
    expect(expansion.contains(link)).toBe(true)
    // Toggling the slot again collapses it.
    fireEvent.click(screen.getByTestId('party-roster-invite'))
    await waitFor(() => {
      expect(screen.queryByTestId('party-roster-invite-expansion')).toBeNull()
    })
  })

  it('a full party (2 real members) shows no invite row', async () => {
    const getCampaigns = vi.fn().mockResolvedValue([
      campaign({
        party: [
          { userId: OWNER, displayName: 'Kessa', hasCharacter: true },
          { userId: MEMBER, displayName: 'Pell', hasCharacter: true },
        ],
      }),
    ])
    const getProgress = vi.fn().mockResolvedValue(
      progress({
        totalMembers: 2,
        concepts: [
          { userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' },
          { userId: MEMBER, displayName: 'Pell', status: 'completed', submittedAt: 't2' },
        ],
      }),
    )
    renderSurface({ viewerUserId: OWNER, deps: { getCampaigns, getProgress } })
    await screen.findByTestId('party-staging')
    expect(screen.getAllByTestId('party-roster-member')).toHaveLength(2)
    expect(screen.queryByTestId('party-roster-invite')).toBeNull()
  })
})

describe('PartyStagingSurface — non-owner', () => {
  it('a member sees the waiting line and NO Begin', async () => {
    // creator is a NAME (not null) → the viewer did not create this world.
    const getCampaigns = vi.fn().mockResolvedValue([
      campaign({
        creator: 'Kessa',
        party: [
          { userId: OWNER, displayName: 'Kessa', hasCharacter: true },
          { userId: MEMBER, displayName: 'Pell', hasCharacter: true },
        ],
      }),
    ])
    const getProgress = vi.fn().mockResolvedValue(
      progress({
        totalMembers: 2,
        concepts: [
          { userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' },
          { userId: MEMBER, displayName: 'Pell', status: 'completed', submittedAt: 't2' },
        ],
      }),
    )
    renderSurface({ viewerUserId: MEMBER, deps: { getCampaigns, getProgress } })
    await screen.findByTestId('party-roster-waiting')
    expect(screen.queryByRole('button', { name: /begin/i })).toBeNull()
  })

  it('fails CLOSED to the member view when the owner probe rejects', async () => {
    const getCampaigns = vi.fn().mockRejectedValue(new Error('boom'))
    renderSurface({ viewerUserId: MEMBER, deps: { getCampaigns } })
    await screen.findByTestId('party-roster-waiting')
    expect(screen.queryByRole('button', { name: /begin/i })).toBeNull()
  })
})

describe('PartyStagingSurface — load lifecycle', () => {
  it('holds on a calm loading line while the fetches are in flight', () => {
    const pending = new Promise<CharacterCreationProgress>(() => {
      /* never resolves */
    })
    renderSurface({ viewerUserId: OWNER, deps: { getProgress: vi.fn(() => pending) } })
    expect(screen.getByTestId('party-staging-loading')).toBeDefined()
    expect(screen.queryByTestId('party-staging')).toBeNull()
  })

  it('surfaces a retryable error and re-fetches the roster on retry', async () => {
    const getProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(progress())
    renderSurface({ viewerUserId: OWNER, deps: { getProgress } })
    await screen.findByTestId('party-staging-error')
    fireEvent.click(screen.getByText(i18n.t('characterCreate.staging.retry')))
    await screen.findByTestId('party-staging')
    expect(getProgress).toHaveBeenCalledTimes(2)
  })

  it('refetches the roster live when a character_creation_complete event arrives', async () => {
    const driver = makeDriver()
    // First fetch: Pell has joined but not built a character (gathering). The event
    // fires; the second fetch shows Pell ready — no manual reload.
    const getProgress = vi
      .fn()
      .mockResolvedValueOnce(
        progress({
          totalMembers: 2,
          concepts: [{ userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' }],
          missing: [{ userId: MEMBER, displayName: 'Pell' }],
        }),
      )
      .mockResolvedValue(
        progress({
          totalMembers: 2,
          concepts: [
            { userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' },
            { userId: MEMBER, displayName: 'Pell', status: 'completed', submittedAt: 't2' },
          ],
        }),
      )
    const getCampaigns = vi.fn().mockResolvedValue([
      campaign({
        party: [
          { userId: OWNER, displayName: 'Kessa', hasCharacter: true },
          { userId: MEMBER, displayName: 'Pell', hasCharacter: false },
        ],
      }),
    ])
    renderSurface({
      viewerUserId: OWNER,
      deps: { getProgress, getCampaigns, createClient: driver.createClient },
    })

    await screen.findByTestId('party-staging')
    const pellRow = (): Element | null =>
      screen.getByText('Pell').closest('[data-testid="party-roster-member"]')
    expect(pellRow()?.getAttribute('data-status')).toBe('gathering')
    // The owner's Begin is enabled throughout — the owner-role + canBegin read is unchanged.
    const beginBefore = await screen.findByRole('button', { name: /begin/i })
    expect((beginBefore as HTMLButtonElement).disabled).toBe(false)

    act(() => {
      driver.emit({ type: 'character_creation_complete', userId: MEMBER })
    })
    await waitFor(() => {
      expect(pellRow()?.getAttribute('data-status')).toBe('ready')
    })
    expect(getProgress.mock.calls.length).toBeGreaterThan(1)
    const beginAfter = await screen.findByRole('button', { name: /begin/i })
    expect((beginAfter as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('PartyStagingSurface — ux-run2 lobby truth (myth-wfgfi)', () => {
  it('leads the ready row with the fetched character name; the account demotes to the sub-line', async () => {
    const getCharacter = vi.fn().mockResolvedValue(characterFull('Sable'))
    renderSurface({
      deps: {
        getProgress: vi.fn().mockResolvedValue(
          progress({
            concepts: [
              {
                userId: OWNER,
                displayName: 'Kessa',
                status: 'completed',
                submittedAt: 't1',
                characterId: 'char-1',
              },
            ],
          }),
        ),
        getCharacter,
      },
    })
    // The character's name arrives as the row's serif primary line.
    const primary = await screen.findByText('Sable')
    expect(getCharacter).toHaveBeenCalledWith(testCtx, CID, 'char-1')
    const row = primary.closest('[data-testid="party-roster-member"]')
    expect(row?.textContent).toContain('Kessa')
    // The fiction leads: the character name is the serif line, the account mono.
    expect(primary.className).toContain('font-body')
  })

  it('carries the partial truth on Begin and finalizes only through the inline confirm', async () => {
    const finalize = vi.fn().mockResolvedValue({ campaignId: CID, jobId: 'job-1' })
    renderSurface({
      deps: {
        finalize,
        getProgress: vi.fn().mockResolvedValue(
          progress({
            totalMembers: 2,
            concepts: [
              { userId: OWNER, displayName: 'Kessa', status: 'completed', submittedAt: 't1' },
              { userId: MEMBER, displayName: 'Pell', status: 'processing', submittedAt: 't2' },
            ],
          }),
        ),
      },
    })
    // The label carries the truth — never a silent gray-out.
    const begin = await screen.findByRole('button', {
      name: i18n.t('characterCreate.staging.beginPartial', { ready: 1, total: 2 }),
    })
    fireEvent.click(begin)
    expect(finalize).not.toHaveBeenCalled()
    // The single confirm: count-aware prompt + the two verbs.
    expect(
      screen.getByText(i18n.t('characterCreate.staging.beginConfirm', { count: 1 })),
    ).toBeDefined()
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('characterCreate.staging.beginConfirmNo') }),
    )
    expect(finalize).not.toHaveBeenCalled()
    // Dismissing remounts the Begin control — re-query before re-arming.
    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('characterCreate.staging.beginPartial', { ready: 1, total: 2 }),
      }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('characterCreate.staging.beginConfirmYes') }),
    )
    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1)
    })
  })
})
