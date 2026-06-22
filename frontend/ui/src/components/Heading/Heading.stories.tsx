import type { Meta, StoryObj } from '@storybook/react-vite'
import { Heading } from './Heading.tsx'

// Heading — section heading primitive. `level` sets the semantic element
// (h1..h6, for document outline + a11y); `role` sets the visual size/weight,
// decoupled from the level so the outline and the visual hierarchy can differ.
// Serif throughout.

const meta: Meta<typeof Heading> = {
  title: 'Typography/Heading',
  component: Heading,
  tags: ['autodocs'],
  argTypes: {
    level: { control: 'inline-radio', options: [1, 2, 3, 4, 5, 6] },
    role: { control: 'inline-radio', options: ['display', 'heading', 'title'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Heading>

export const Display: Story = {
  args: { level: 1, role: 'display' },
  render: (args) => <Heading {...args}>The Hollow Road</Heading>,
}

export const HeadingRole: Story = {
  name: 'Heading',
  args: { level: 2, role: 'heading' },
  render: (args) => <Heading {...args}>Chapter the First</Heading>,
}

export const Title: Story = {
  args: { level: 3, role: 'title' },
  render: (args) => <Heading {...args}>A Quiet Inn</Heading>,
}

export const DecoupledLevel: Story = {
  name: 'Decoupled level (h3 at display size)',
  args: { level: 3, role: 'display' },
  render: (args) => <Heading {...args}>Semantic h3, visual display</Heading>,
}
