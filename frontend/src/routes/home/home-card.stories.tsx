import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { Stack } from '@mythrun/ui'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CampaignCard } from './home-card.tsx'

// Storybook specimens for the campaign-hub cover card (MYT-87 rework — "The
// Cover"): a portrait book cover with a full-bleed cover-dither header (~40%), a
// serif title + italic world · creator sub-line, and a mono ledger imprint (party
// seals over the record/state line) pinned to the FOOT. The specimens cover every
// viewer-relative `cardPhase`, a mix of chromatic and monochromatic world-colour
// pairs, the joined-world creator credit, the +N seal overflow, and the ghost band
// (a still-generating world with no colour pick). Toggle the toolbar THEME to watch
// each cover re-ink — the card surface flips light↔dark and the CoverDither swaps
// its two colour values with no per-card JavaScript.
//
// The state/record COPY is still the `[ph_…]` placeholder set (short strings land
// with the copy pass, bead myth-lxm7m) — the specimens exercise the card STRUCTURE,
// not the final wording.

const DAY_MS = 86_400_000

/** A complete hub-card fixture; each specimen overrides only what it demonstrates. */
function campaign(
  overrides: Partial<CampaignSummary> & Pick<CampaignSummary, 'id'>,
): CampaignSummary {
  return {
    worldId: 'w-1',
    name: 'The Sunken Coast',
    status: 'active',
    language: 'en',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    worldName: 'Aerth',
    worldColors: { from: 'verdigris-200', to: 'moss-800' },
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...overrides,
  }
}

// Single-word display names → single-letter seal initials (A, B, C…), the way the
// name-derived pigment tiles read on a real party.
const PARTY_NAMES = ['Ada', 'Bram', 'Cyra', 'Dane', 'Esk', 'Fenn', 'Gale'] as const
const partyOf = (n: number): CampaignSummary['party'] =>
  Array.from({ length: n }, (_, i) => ({
    userId: `u-${String(i)}`,
    displayName: PARTY_NAMES[i % PARTY_NAMES.length] ?? `Player ${String(i)}`,
    hasCharacter: true,
  }))

// One card per viewer-relative phase, spanning chromatic + monochromatic pairs, the
// joined-world creator credit, the +N overflow, and the ghost (no colour pick yet).
const NOT_PLAYED = campaign({
  id: 'c-not-played',
  name: 'The Verdigris Court',
  worldName: 'Selavere',
  worldColors: { from: 'verdigris-200', to: 'moss-800' },
  party: partyOf(2),
  cardPhase: 'not-played',
})

const NEEDS_CHARACTER = campaign({
  id: 'c-needs-character',
  name: 'The Coral Throne',
  worldName: 'The Reef',
  worldColors: { from: 'sienna-200', to: 'verdigris-800' },
  creator: 'Bram',
  party: partyOf(3),
  cardPhase: 'needs-character',
})

const WAITING = campaign({
  id: 'c-waiting',
  name: 'Harrow of the Iris Fen',
  worldName: 'The Iris Fen',
  worldColors: { from: 'lapis-100', to: 'lapis-900' },
  party: partyOf(3),
  cardPhase: 'waiting-for-players',
})

const PLAYED = campaign({
  id: 'c-played',
  name: 'The Rose Assembly',
  worldName: 'Ondemor',
  worldColors: { from: 'rose-100', to: 'rose-800' },
  creator: 'Bram',
  party: partyOf(7),
  sessionCount: 4,
  lastPlayedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
  cardPhase: 'played',
})

const FAILED = campaign({
  id: 'c-failed',
  name: 'The Amber Steppe',
  worldName: 'Karthvalen',
  worldColors: { from: 'ochre-200', to: 'ember-800' },
  party: partyOf(2),
  cardPhase: 'failed',
})

const GENERATING = campaign({
  id: 'c-generating',
  name: 'The Drowned Cathedral',
  worldName: 'Aerthmoor',
  worldColors: null,
  party: partyOf(1),
  cardPhase: 'generating',
})

const SPECIMENS: readonly CampaignSummary[] = [
  NOT_PLAYED,
  NEEDS_CHARACTER,
  WAITING,
  PLAYED,
  FAILED,
  GENERATING,
]

const meta: Meta<typeof CampaignCard> = {
  title: 'Home/CampaignCard',
  component: CampaignCard,
  tags: ['autodocs'],
  parameters: {
    // A lone card specimen is a fragment, not a document, so it has no page-level
    // <h1> — every card's title is an <h2>. Disable ONLY axe's best-practice
    // page-has-heading-one rule (the real hub page owns the h1); every other a11y
    // rule stays enforced on the specimens.
    a11y: { config: { rules: [{ id: 'page-has-heading-one', enabled: false }] } },
  },
  decorators: [
    (Story) => (
      <I18nextProvider i18n={i18n}>
        <Story />
      </I18nextProvider>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CampaignCard>

// The full shelf — one cover per phase, so the 375/1280 overflow gate and the
// visual audit see every state at once (toggle the toolbar theme for the re-ink).
export const Shelf: Story = {
  render: () => (
    <Stack direction="row" wrap align="start" gap={4}>
      {SPECIMENS.map((c) => (
        <CampaignCard key={c.id} campaign={c} />
      ))}
    </Stack>
  ),
}

// A single cover, isolated — the default autodocs specimen (own world, ready to play).
export const Single: Story = {
  render: () => <CampaignCard campaign={NOT_PLAYED} />,
}

// The ghost — a still-generating world with no colour pick yet: the muted paper band.
export const Generating: Story = {
  render: () => <CampaignCard campaign={GENERATING} />,
}
