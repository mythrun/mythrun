import type { Meta, StoryObj } from '@storybook/react-vite'
import { Text } from './Text.tsx'
import { Stack } from '../Stack/Stack.tsx'

// Text — the body-altitude typography primitive. Applies a typographic ROLE
// (family + size + weight + tracking) from the token scale; `as` picks the
// semantic element (span/p) independently of the visual role. Headings (display
// size and up) live in the Heading component.

const meta: Meta<typeof Text> = {
  title: 'Typography/Text',
  component: Text,
  tags: ['autodocs'],
  argTypes: {
    role: { control: 'inline-radio', options: ['prose-body', 'ui-label', 'ui-caption', 'data'] },
    as: { control: 'inline-radio', options: ['span', 'p'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Text>

export const ProseBody: Story = {
  name: 'Prose body',
  args: { role: 'prose-body', as: 'p' },
  render: (args) => (
    <Text {...args}>
      The lantern guttered once and held. Beyond the threshold the corridor breathed cold air, and
      somewhere below, water moved against stone.
    </Text>
  ),
}

export const UiLabel: Story = {
  name: 'UI label',
  args: { role: 'ui-label' },
  render: (args) => <Text {...args}>Character sheet</Text>,
}

export const UiCaption: Story = {
  name: 'UI caption',
  args: { role: 'ui-caption' },
  render: (args) => <Text {...args}>Last saved a moment ago</Text>,
}

export const Data: Story = {
  args: { role: 'data' },
  render: (args) => <Text {...args}>HP 24 / 30 · AC 16</Text>,
}

export const Truncated: Story = {
  name: 'Truncated (single line)',
  args: { role: 'ui-label', truncate: true },
  render: (args) => (
    <div className="max-w-[220px]">
      <Stack direction="row">
        <Text {...args}>A display name that is far too long to fit on one comfortable line</Text>
      </Stack>
    </div>
  ),
}
