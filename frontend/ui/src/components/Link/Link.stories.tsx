import type { Meta, StoryObj } from '@storybook/react-vite'
import { Link } from './Link.tsx'

// Link — navigational link primitive. Renders a real <a href> with the ember
// accent color, underline-on-hover, and the theme-aware focus ring (tab to it
// to see the 2px accent outline). `onPress` is the platform-neutral activation
// callback; `external` opens a new context with a safe rel.

const meta: Meta<typeof Link> = {
  title: 'Typography/Link',
  component: Link,
  tags: ['autodocs'],
  argTypes: {
    href: { control: 'text' },
    external: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Link>

export const Internal: Story = {
  args: { href: '/campaign' },
  render: (args) => <Link {...args}>Return to your campaign</Link>,
}

export const External: Story = {
  args: { href: 'https://example.com', external: true },
  render: (args) => <Link {...args}>Open the rules reference</Link>,
}
