import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from './Avatar.tsx'
import { AvatarGroup } from './AvatarGroup.tsx'

// AvatarGroup — an overlapping cluster of Avatars, each separated from the one
// beneath by a token ring (the page color) so the stack reads as distinct faces.
// When the child count exceeds `max`, the first `max` render and a trailing `+N`
// overflow chip stands in for the rest.

const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Ken Thompson', 'Barbara Liskov']

const meta: Meta<typeof AvatarGroup> = {
  title: 'Identity/AvatarGroup',
  component: AvatarGroup,
  tags: ['autodocs'],
  argTypes: { max: { control: { type: 'number' } } },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof AvatarGroup>

// Under the cap — every face shows, no overflow chip.
export const Cluster: Story = {
  render: () => (
    <AvatarGroup max={6}>
      {PEOPLE.slice(0, 4).map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </AvatarGroup>
  ),
}

// Over the cap — the first `max` render, the rest collapse into `+N`.
export const Overflow: Story = {
  render: () => (
    <AvatarGroup max={3}>
      {PEOPLE.map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </AvatarGroup>
  ),
}

// No cap — every avatar renders.
export const Uncapped: Story = {
  render: () => (
    <AvatarGroup>
      {PEOPLE.slice(0, 5).map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </AvatarGroup>
  ),
}
