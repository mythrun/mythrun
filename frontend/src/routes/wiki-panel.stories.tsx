import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { toWikiViewModel } from '@mythrun/client-core/worldgen'
import { i18n } from '../i18n/config.ts'
import { WikiPanel, type WikiModelState } from './wiki-panel.tsx'

// The promoted world-wiki panel (MYT-102) — mounted both in the world reveal and
// beside the character-create concept prompts. Deterministic specimens: a
// resolved known-tier model, the calm loading line, and the unavailable line.
// Every chrome label resolves from the app catalog (the DS owns no copy); the
// story provides i18n. The 375/1280 overflow gate measures each state.

const SNAPSHOT: Parameters<typeof toWikiViewModel>[0] = {
  introduction: {
    title: 'The Ashfen Reaches',
    prose:
      '[placeholder for the first introduction paragraph — long enough to wrap at rail width and show the prose measure]\n\n[placeholder for the second introduction paragraph]',
    references: [{ entityId: 'f-guild', name: 'The Tallow Guild' }],
  },
  entities: [
    { id: 'f-guild', entityType: 'faction', name: 'The Tallow Guild' },
    { id: 'l-reach', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'n-vale', entityType: 'npc', name: 'Maeris Vale' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'f-guild', topic: 'Purpose', content: '[placeholder for the guild purpose]' },
    { id: 'fact-2', entityId: 'l-reach', topic: 'Terrain', content: '[placeholder for the terrain of the reach]' },
  ],
  entityHierarchy: [],
  relationships: [{ sourceEntityId: 'n-vale', targetEntityId: 'f-guild', relationshipType: 'sworn_to' }],
}

const READY: WikiModelState = { model: toWikiViewModel(SNAPSHOT), loading: false, failed: false }
const LOADING: WikiModelState = { model: null, loading: true, failed: false }
const UNAVAILABLE: WikiModelState = { model: null, loading: false, failed: true }

/** A bounded rail stage so the overflow gate measures the panel at a real width. */
function Stage({ state }: { state: WikiModelState }): React.JSX.Element {
  const [query, setQuery] = useState('')
  return (
    <I18nextProvider i18n={i18n}>
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- story-only bounded rail stage so the overflow gate measures the panel at a real rail width; not shipped UI */}
      <div className="h-[42rem] w-full max-w-[24rem] overflow-hidden bg-bg p-[var(--space-4)]">
        <WikiPanel
          state={state}
          externalSelection={undefined}
          onSelect={() => undefined}
          query={query}
          onQuery={setQuery}
        />
      </div>
    </I18nextProvider>
  )
}

const meta: Meta<typeof WikiPanel> = {
  title: 'Screens/WikiPanel',
  component: WikiPanel,
  parameters: { layout: 'padded' },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof WikiPanel>

export const Ready: Story = { render: () => <Stage state={READY} /> }
export const Loading: Story = { render: () => <Stage state={LOADING} /> }
export const Unavailable: Story = { render: () => <Stage state={UNAVAILABLE} /> }
