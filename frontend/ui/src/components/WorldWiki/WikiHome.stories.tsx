import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { WikiHome } from './WikiHome.tsx'
import type { WikiView } from './WikiViewSwitch.tsx'
import { WIKI_FIXTURE_MODEL, WIKI_FIXTURE_MODEL_BARE } from './wiki-fixture.ts'

// WikiHome — the wiki's landing. With an introduction on the model it is the
// world's front door: the serif world-name title, the grounding prose as
// paragraphs, the dig-deeper references, then the mono INDEX label over the
// search + browse-by-kind groups, closed by the world GLOSSARY (MYT-102) —
// mono terms over serif definitions — one scrolling field-guide surface.
// Without an introduction (a pre-migration world) it is the browse landing
// alone. Flat 1-bit paper register: hairline rules between sections, no boxes
// or chips.

const meta: Meta<typeof WikiHome> = {
  title: 'Patterns/WorldWiki/WikiHome',
  component: WikiHome,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WikiHome>

const LABELS = {
  searchLabel: '[placeholder for the search field label]',
  searchPlaceholder: '[placeholder for the search hint]',
  emptyLabel: '[placeholder for the empty-results note]',
  referencesLabel: '[placeholder for dig deeper]',
  indexLabel: '[placeholder for index]',
  glossaryLabel: '[placeholder for glossary]',
  groupLabels: {
    faction: '[placeholder for Factions]',
    location: '[placeholder for Locations]',
    npc: '[placeholder for People]',
    item: '[placeholder for Items]',
  },
} as const

// ux-run3 myth-ry14g — the play sidebar's presence split: the entities the live
// session has already named lead their group. The reveal passes none of this.
const PRESENCE = {
  ids: ['l-reach'],
  presentLabel: '[placeholder for this session]',
  elsewhereLabel: '[placeholder for elsewhere]',
}

interface HomeDemoProps {
  initialQuery?: string
  initialView?: WikiView
  model?: typeof WIKI_FIXTURE_MODEL
  presence?: typeof PRESENCE
}

function HomeDemo({
  initialQuery = '',
  initialView = 'index',
  model = WIKI_FIXTURE_MODEL,
  presence,
}: HomeDemoProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState(initialQuery)
  const [view, setView] = useState<WikiView>(initialView)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto h-[70vh] max-w-sm">
        <WikiHome
          model={model}
          selectedId={selectedId}
          onOpen={setSelectedId}
          query={query}
          onQuery={setQuery}
          view={view}
          onViewChange={setView}
          {...LABELS}
          {...(presence !== undefined ? { presence } : {})}
        />
      </div>
    </div>
  )
}

// The INDEX view (the default): the segmented Index / Glossary switch pinned
// above the world-name title, the intro prose, the dig-deeper references, and
// the search + browse groups scrolling beneath. Opening a row marks it here
// (the composed WorldWiki navigates to the page instead — see
// Patterns/WorldWiki/WorldWiki).
export const Introduction: Story = {
  render: () => <HomeDemo />,
}

// The GLOSSARY view: the switch flipped to Glossary — the world's vocabulary as
// a collapsible, scannable list (definitions disclosed on demand).
export const Glossary: Story = {
  render: () => <HomeDemo initialView="glossary" />,
}

// A world whose flagship glossary entry runs LONGER than the panel (the myth-lcvv2
// case: run-1's "Heartfire" definition fell off the bottom mid-sentence, with no
// scrollbar or fade to say it continued). Mounted at the reveal's own row height and
// with the long entry expanded by the play(), so the overflow is real: the fix — a
// persistent scrollbar + a bottom fade — must announce that there is more to read.
const LONG_GLOSSARY_MODEL: typeof WIKI_FIXTURE_MODEL = {
  ...WIKI_FIXTURE_MODEL,
  glossary: [
    {
      term: 'Heartfire',
      definition:
        'The bottled warmth sold by the Priesthood of the Heart, alchemically compressed thermal energy, amber-colored, stored in brass-capped glass vials roughly the size of a fist. A single vial burns for one hour in a standard hearthbox. The name implies sacred origin; the Priesthood maintains that Heartfire is drawn from the residual spiritual warmth of the titan\'s petrified cardiac organ, a claim no rival guild has ever been permitted to test. What is certain is that the Reach cannot winter without it, and the Priesthood alone holds the license to make or sell it.',
    },
    ...WIKI_FIXTURE_MODEL.glossary,
  ],
}

function LongGlossaryDemo(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<WikiView>('glossary')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      {/* The reveal's own row height (RevealPanes' clamp lands ~27rem at 800px tall),
          so the long definition genuinely overflows the panel — the exact condition. */}
      <div className="mx-auto h-[27rem] max-w-sm">
        <WikiHome
          model={LONG_GLOSSARY_MODEL}
          selectedId={selectedId}
          onOpen={setSelectedId}
          query={query}
          onQuery={setQuery}
          view={view}
          onViewChange={setView}
          {...LABELS}
        />
      </div>
    </div>
  )
}

// The overflow-announce regression case: a long definition expanded in a
// panel-height glossary. The play() opens Heartfire so the definition overruns the
// panel; the persistent scrollbar + bottom fade must make the truncation legible.
export const GlossaryLongDefinition: Story = {
  render: () => <LongGlossaryDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Heartfire'))
    await expect(canvas.getByText(/residual spiritual warmth/)).toBeVisible()
  },
}

// A pre-migration world (no introduction OR glossary): the browse landing alone
// — no switch, the search over the scrolling groups. The graceful absence.
export const BrowseOnly: Story = {
  render: () => <HomeDemo model={WIKI_FIXTURE_MODEL_BARE} />,
}

// The search-narrowed state: a preset query filters the browse groups (keeping a
// nested match's ancestor path); the field is live, so clearing it restores
// the full browse view.
export const Filtered: Story = {
  render: () => <HomeDemo initialQuery="ward" />,
}

// The IN-SESSION index (ux-run3 myth-ry14g): each row carries its one-line
// handle, and the group the live transcript has touched leads with those entries
// under a quiet sub-label — the rest file below their own. A group with only one
// half stays unsplit (no lonely heading).
export const InSessionPresence: Story = {
  render: () => <HomeDemo presence={PRESENCE} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('[placeholder for this session]')).toBeVisible()
    await expect(canvas.getByText('[placeholder for elsewhere]')).toBeVisible()
  },
}
