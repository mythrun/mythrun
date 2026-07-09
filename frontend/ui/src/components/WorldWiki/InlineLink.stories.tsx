import type { Meta, StoryObj } from '@storybook/react-vite'
import { InlineLink } from './InlineLink.tsx'
import { Text } from '../Text/Text.tsx'

// InlineLink — the SCAFFOLD for an in-prose entity mention. By the plan's §8.1
// decision the v1 wiki body does NOT auto-linkify (no name-matching over fact
// text — collision hazard + ZFC-tension pattern-matching); the RELATED footer
// carries cross-navigation. This catalogues the affordance a future
// marked-mention pipeline would render: a native button painted as a prose
// link, sitting flush inside the serif fact body.

const meta: Meta<typeof InlineLink> = {
  title: 'Patterns/WorldWiki/InlineLink',
  component: InlineLink,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof InlineLink>

// The link inside its natural habitat: a fact passage. Persistent underline
// (an in-prose link cannot signal by color alone), accent ink, the prose-body
// register — the sentence reads unbroken.
export const InProse: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto max-w-sm">
        <Text role="prose-body" as="p">
          [placeholder for fact prose before a mention of]{' '}
          <InlineLink entityId="n-vale" onNavigate={() => undefined}>
            Maeris Vale
          </InlineLink>{' '}
          [placeholder for the rest of the passage after the mention]
        </Text>
      </div>
    </div>
  ),
}
