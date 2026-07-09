import type { Meta, StoryObj } from '@storybook/react-vite'
import { RelatedFooter } from './RelatedFooter.tsx'
import { wikiFixtureEntity } from './wiki-fixture.ts'

// RelatedFooter — a page's "see also": plain rows under a hairline rule and a
// quiet mono section label. The target name is the link (accent ink, underline
// on hover); the de-snaked relationship label sits mono and quiet at the row's
// right edge. No chips, no pills.

const meta: Meta<typeof RelatedFooter> = {
  title: 'Patterns/WorldWiki/RelatedFooter',
  component: RelatedFooter,
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

type Story = StoryObj<typeof RelatedFooter>

// The fixture guild's three real relationship endpoints, labels de-snaked by
// the view model (`sworn_to` → "sworn to").
export const Default: Story = {
  args: {
    related: wikiFixtureEntity('f-guild').related,
    label: '[placeholder for related]',
    onOpen: () => undefined,
  },
}
