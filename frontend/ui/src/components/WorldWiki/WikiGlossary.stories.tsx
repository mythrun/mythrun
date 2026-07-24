import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiGlossary } from './WikiGlossary.tsx'
import { WIKI_FIXTURE_MODEL } from './wiki-fixture.ts'

// WikiGlossary — the world's vocabulary as a scannable, collapsible list: the
// term reads first (mono data register), the definition disclosed on demand via
// native <details>/<summary> with a flat +/− marker (square register).

const meta: Meta<typeof WikiGlossary> = {
  title: 'Patterns/WorldWiki/WikiGlossary',
  component: WikiGlossary,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-dvh bg-bg p-[var(--space-6)]">
        <div className="mx-auto max-w-sm">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WikiGlossary>

// The fixture world's three vocabulary terms (term-sorted by the view model),
// all collapsed at first paint — the eye scans the column and opens what it wants.
export const Default: Story = {
  args: {
    glossary: WIKI_FIXTURE_MODEL.glossary,
  },
}
