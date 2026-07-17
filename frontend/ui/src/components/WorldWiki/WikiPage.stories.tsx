import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiPage } from './WikiPage.tsx'
import { wikiFixtureEntity } from './wiki-fixture.ts'

// WikiPage — one entity as a field-guide plate: the mono kind tag over the
// serif name, the prose KERNEL (the entity's actual description, MYT-102) as
// serif paragraphs, the composed fact body below (topic over content), the
// RELATED footer carrying cross-navigation, and the quiet pinned back button.
// The empty-body variant shows the calm honest note an undescribed entity gets
// — no fake prose.

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

// A populated page: the guild's two-paragraph kernel description FIRST, then
// two fact passages, then four RELATED links (the fixture's
// relationship-bearing guild).
export const Populated: Story = {
  args: {
    entity: wikiFixtureEntity('f-guild'),
    kindLabel: '[placeholder for Factions]',
  },
}

// The kernel-only page (MYT-102): a described entity whose world recorded no
// facts yet — the prose description carries the page alone, no topic labels,
// no empty note.
export const KernelOnly: Story = {
  args: {
    entity: wikiFixtureEntity('l-mill'),
    kindLabel: '[placeholder for Locations]',
  },
}

// The empty-body page: no kernel AND no facts — a calm note, and the related
// reading still carries the reader onward.
export const EmptyBody: Story = {
  args: {
    entity: wikiFixtureEntity('l-spire'),
    kindLabel: '[placeholder for Locations]',
  },
}
