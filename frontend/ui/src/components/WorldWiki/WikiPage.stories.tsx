import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiPage } from './WikiPage.tsx'
import { wikiFixtureEntity } from './wiki-fixture.ts'

// WikiPage — one entity as a field-guide plate: the mono kind tag over the
// serif name, the composed fact body (topic over content), the RELATED footer
// carrying cross-navigation, and the quiet pinned back button. The empty-body
// variant shows the calm honest note a fact-less entity gets — no fake prose.

const meta: Meta<typeof WikiPage> = {
  title: 'Patterns/WorldWiki/WikiPage',
  component: WikiPage,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    backLabel: '[placeholder for back]',
    relatedLabel: '[placeholder for related]',
    emptyBodyLabel: '[placeholder for the empty-page note]',
    onBack: () => undefined,
    onOpenRelated: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="min-h-dvh bg-bg p-[var(--space-6)]">
        <div className="mx-auto h-[70vh] max-w-sm">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WikiPage>

// A populated page: two facts of body and three RELATED links (the fixture's
// relationship-bearing guild).
export const Populated: Story = {
  args: {
    entity: wikiFixtureEntity('f-guild'),
    kind: 'faction',
  },
}

// The empty-body page: the world recorded no facts here (yet) — a calm note,
// and the related reading still carries the reader onward.
export const EmptyBody: Story = {
  args: {
    entity: wikiFixtureEntity('l-spire'),
    kind: 'location',
  },
}
