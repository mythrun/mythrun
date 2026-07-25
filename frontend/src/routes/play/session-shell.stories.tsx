import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@mythrun/ui'
import { StoryQueryProvider } from '../../storybook/story-query-provider.tsx'
import { toWikiViewModel } from '@mythrun/client-core/worldgen'
import type {
  ApiContext,
  KnowledgeCache,
  SessionSheetState,
  SessionView,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { SessionShell } from './session-shell.tsx'
import type { PlayKnowledgeHooks } from './knowledge-panel.tsx'

// Screens/SessionShell — the LIVE `ready` play stage: the streamed transcript +
// input beside the knowledge sidebar. This story exists chiefly to pin the
// LAYOUT-CITIZEN contract (MYT-100 scroll containment): a TALL wiki must scroll
// INSIDE the sidebar pane, never grow the page and push the chat input off-screen.
// The `min-h-screen` wrapper reproduces the real app-frame full-bleed chain (the
// frame root is a viewport FLOOR, so an unbounded pane would escape it) — the
// input must stay on-screen with a long wiki open.

const CTX: ApiContext = { baseUrl: 'http://storybook.invalid', getAuthHeaders: () => Promise.resolve({}) }

// Identity/route props are DATA, not copy — hoisted so the JSX carries no literal
// strings (the i18next/no-literal-string rail applies to stories too).
const CAMPAIGN_ID = 'c-1'
const SESSION_ID = 's-1'
const VIEWER_ID = 'u-1'
const DISPLAY_NAME = 'Wren'
const PARTY = new Map([[VIEWER_ID, DISPLAY_NAME]])

// A deliberately TALL world: a long introduction + several groups + a glossary, so
// the wiki content far exceeds a rail's height — the scroll-containment specimen.
const TALL_WIKI = toWikiViewModel({
  introduction: {
    title: 'The Ashfen Reaches',
    prose: Array.from(
      { length: 6 },
      (_, i) =>
        `[placeholder introduction paragraph ${String(i + 1)} — a long grounding passage that wraps at rail width and, stacked six deep, makes the wiki taller than the viewport so the pane must scroll internally rather than grow the page]`,
    ).join('\n\n'),
    references: [
      { entityId: 'f-guild', name: 'The Tallow Guild' },
      { entityId: 'n-vale', name: 'Maeris Vale' },
    ],
  },
  entities: [
    { id: 'f-guild', entityType: 'faction', name: 'The Tallow Guild' },
    { id: 'f-ring', entityType: 'faction', name: 'The Saltmen' },
    { id: 'l-reach', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'l-ward', entityType: 'location', name: 'The Drowned Ward' },
    { id: 'l-spire', entityType: 'location', name: 'Sunspire' },
    { id: 'l-mill', entityType: 'location', name: 'The Cinder Mill' },
    { id: 'n-vale', entityType: 'npc', name: 'Maeris Vale' },
    { id: 'n-corr', entityType: 'npc', name: 'Corrin Salt' },
    { id: 'i-ledger', entityType: 'item', name: 'The Salt Ledger' },
  ],
  facts: [],
  entityHierarchy: [{ parentEntityId: 'l-reach', childEntityId: 'l-ward' }],
  relationships: [
    { sourceEntityId: 'n-vale', targetEntityId: 'f-guild', relationshipType: 'sworn_to' },
    { sourceEntityId: 'l-spire', targetEntityId: 'f-guild', relationshipType: 'watched_by' },
  ],
  world: {
    vocabularyRegistry: {
      entries: [
        { term: 'tallow-run', definition: '[placeholder for what a tallow-run is in the reach]' },
        { term: 'ashfen', definition: '[placeholder for what the ashfen itself is]' },
        { term: 'lampblack', definition: '[placeholder for what lampblack means here]' },
        { term: 'saltward', definition: '[placeholder for the saltward custom]' },
      ],
    },
  },
})

const CACHE: KnowledgeCache = { wiki: TALL_WIKI, graph: null, index: null, loading: false, failed: false }
const SHEET: SessionSheetState = {
  sheet: null,
  overlay: { hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null },
  loading: false,
  failed: true,
}
const KNOWLEDGE_HOOKS: PlayKnowledgeHooks = { useCache: () => CACHE, useSheet: () => SHEET }

// A short transcript — a handful of DM/player lines so the chat column has content
// beneath the (contained) sidebar.
const ITEMS: SessionView['items'] = [
  { kind: 'dm', key: 'dm-1', turnId: 'T1', text: '[placeholder DM opening — you step onto the reach as the tide draws out]', streaming: false },
  {
    kind: 'player',
    key: 'p-1',
    turnId: null,
    seq: 1,
    userId: 'u-1',
    displayName: 'Wren',
    characterName: 'Kessa',
    text: '[placeholder player line]',
    pending: false,
  },
  { kind: 'dm', key: 'dm-2', turnId: 'T3', text: '[placeholder DM reply — the guildhall doors are shut against the wind]', streaming: false },
]

function makeSession(): SessionView {
  return {
    items: ITEMS,
    connection: { status: 'connected', attempt: 0 },
    thinking: false,
    typingUserIds: [],
    ended: false,
    sendMessage: () => undefined,
    summonDm: () => undefined,
    endSession: () => undefined,
  }
}

const meta: Meta<typeof SessionShell> = {
  title: 'Screens/SessionShell',
  component: SessionShell,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
  decorators: [
    (Story) => (
      // The query provider mirrors the app root: the shell's mount-time balance
      // invalidation (myth-q53lj) reads the query client.
      <StoryQueryProvider>
        <ThemeProvider>
          <I18nextProvider i18n={i18n}>
            <MemoryRouter>
              {/* Reproduces the app-frame full-bleed chain: a viewport FLOOR root
                  (min-h-screen) → the min-h-0 flex-1 content region → the shell. */}
              {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- story stand-in for the app-frame full-bleed root (min-h-screen) + its min-h-0 flex-1 content region */}
              <div className="flex min-h-screen flex-col">
                {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the app-frame full-bleed content region (min-h-0 flex-1) the play route fills */}
                <div className="flex min-h-0 flex-1 flex-col">
                  <Story />
                </div>
              </div>
            </MemoryRouter>
          </I18nextProvider>
        </ThemeProvider>
      </StoryQueryProvider>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SessionShell>

// The live shell with a TALL wiki open in the sidebar. The scroll-containment
// contract: the chat input stays on-screen (the wiki scrolls inside its pane).
export const LiveWithTallWiki: Story = {
  render: () => (
    <SessionShell
      ctx={CTX}
      campaignId={CAMPAIGN_ID}
      sessionId={SESSION_ID}
      viewerUserId={VIEWER_ID}
      displayName={DISPLAY_NAME}
      characterName=""
      party={PARTY}
      reducedMotion
      useLiveSession={makeSession}
      knowledgeHooks={KNOWLEDGE_HOOKS}
    />
  ),
}
