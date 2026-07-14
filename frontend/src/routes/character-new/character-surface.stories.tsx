import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  createSseStatusClient,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
  type CharacterFull,
  type SseStatusClient,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CharacterSurface, type CharacterSurfaceDeps } from './character-surface.tsx'

// CharacterSurface — the MYT-90 D8 integrator: the §3.3 routing table + the
// character-context failure. Each specimen feeds fixed viewer/situation/concept
// signals through the `deps` seam so the surface settles on ONE screen WITHOUT a
// live backend, for the E1 responsive/a11y sweep. The redirect rows
// (situation/level/create) are navigations, not screens — covered by the discrete
// routes; the reveal/loading/staging beats are the committed surfaces (mounted
// here). Routing wiring is covered by character-surface.test.tsx.

const CID = 'story-campaign'
const VIEWER = 'viewer'
const CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

function campaign(over: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: CID,
    worldId: 'world-1',
    name: 'The Hollow Road',
    status: 'setup',
    language: 'en',
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z',
    worldName: 'Aldermoor',
    worldColors: null,
    creator: null,
    party: [{ userId: VIEWER, displayName: 'Miklos', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'needs-character',
    ...over,
  }
}

const situations = (
  chosenIndex: number | null,
  startingLevel: number | null,
): StartingSituationsResponse => ({ situations: [], chosenIndex, startingLevel })

type Concept = CharacterCreationProgress['concepts'][number]
const myConcept = (over: Partial<Concept> = {}): Concept => ({
  userId: VIEWER,
  displayName: 'Miklos',
  status: 'processing',
  submittedAt: '2026-07-11T10:00:00.000Z',
  confirmedAt: null,
  characterId: null,
  ...over,
})
const progress = (concepts: readonly Concept[]): CharacterCreationProgress => ({
  campaignId: CID,
  totalMembers: concepts.length,
  concepts: [...concepts],
  missing: [],
})

// A never-opened SSE client so the mounted loading beat never touches the network.
const loadingStub = {
  createClient: (ctx: ApiContext): SseStatusClient => {
    const { connectionState } = createSseStatusClient(ctx)
    return {
      open: () => undefined,
      onEvent: () => () => undefined,
      onSnapshot: () => () => undefined,
      connectionState,
      close: () => undefined,
    }
  },
}

// A finished martial sheet for the reveal specimen (mirrors character-reveal.stories).
const SHEET: CharacterFull = {
  character: {
    id: 'char-1',
    user_id: VIEWER,
    entity_id: null,
    name: 'Kessa Vurm',
    level: 3,
    class: 'Fighter',
    species: 'Human',
    background: 'Toll-clerk of Greenward',
    str: 16,
    dex: 13,
    con: 15,
    int: 12,
    wis: 11,
    cha: 9,
    hit_points: 28,
    max_hit_points: 28,
    armor_class: 16,
    proficiency_bonus: 2,
    gold: 9,
    hit_die: 10,
    hit_dice_remaining: 3,
    spellcasting_progression: 'none',
    created_at: '2026-07-11T10:00:00.000Z',
    updated_at: '2026-07-11T10:00:00.000Z',
  },
  skills: [
    { skill_name: 'Athletics', proficiency_level: 'proficient' },
    { skill_name: 'Perception', proficiency_level: 'proficient' },
  ],
  features: [
    {
      feature_name: 'Second Wind',
      feature_source: 'Fighter',
      description: 'Catch her breath: recover a burst of HP once per rest.',
    },
  ],
  equipment: [
    { item_name: 'Longsword', quantity: 1, equipped: true },
    { item_name: 'Chain mail', quantity: 1, equipped: true },
  ],
  spells: [],
}

function baseDeps(over: Partial<CharacterSurfaceDeps> = {}): CharacterSurfaceDeps {
  return {
    fetchMe: () => Promise.resolve({ user: { id: VIEWER } }),
    fetchSituations: () => Promise.resolve(situations(0, 1)),
    fetchProgress: () => Promise.resolve(progress([myConcept()])),
    loading: loadingStub,
    reveal: { getCharacter: () => Promise.resolve(SHEET) },
    staging: {
      getProgress: () =>
        Promise.resolve(progress([myConcept({ status: 'completed', characterId: 'char-1' })])),
      getCampaigns: () => Promise.resolve([campaign()]),
      createClient: loadingStub.createClient,
    },
    ...over,
  }
}

function render(campaignArg: CampaignSummary, deps: CharacterSurfaceDeps): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[`/campaigns/${CID}`]}>
      <I18nextProvider i18n={i18n}>
        <ApiClientProvider value={CTX}>
          <CharacterSurface campaign={campaignArg} campaignId={CID} deps={deps} />
        </ApiClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  )
}

const meta: Meta<typeof CharacterSurface> = {
  title: 'Screens/CharacterSurface',
  component: CharacterSurface,
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterSurface>

// Member, before the host has set the opening — the "setting up the table" hold.
export const MemberHold: Story = {
  name: 'Member — setting up the table (hold)',
  render: () => render(campaign({ creator: 'Miklos' }), baseDeps({ fetchSituations: () => Promise.resolve(situations(null, null)) })),
}

// A concept still processing — the "coming into being" loading beat.
export const Loading: Story = {
  name: 'Loading (coming into being)',
  render: () => render(campaign(), baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'processing' })])) })),
}

// A finished, unconfirmed character — the "meet your character" reveal.
export const Reveal: Story = {
  name: 'Meet your character (reveal)',
  render: () =>
    render(campaign(), baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'completed', characterId: 'char-1' })])) })),
}

// A confirmed character — the party staging (solo owner, Begin enabled).
export const Staging: Story = {
  name: 'Party staging (confirmed)',
  render: () =>
    render(campaign(), baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'completed', characterId: 'char-1', confirmedAt: '2026-07-11T10:10:00.000Z' })])) })),
}

// A failed concept — the character-context failure + retry (NOT the world-gen terminal).
export const FailedConcept: Story = {
  name: 'Character-context failure (concept)',
  render: () => render(campaign(), baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'failed' })])) })),
}

// A terminal integration failure — the same character-context surface, integration copy.
export const FailedIntegration: Story = {
  name: 'Character-context failure (integration)',
  render: () => render(campaign({ status: 'failed' }), baseDeps()),
}

// An integrated character / active campaign — the play entry.
export const Play: Story = {
  name: 'Play entry (ready)',
  render: () => render(campaign({ status: 'active' }), baseDeps()),
}
