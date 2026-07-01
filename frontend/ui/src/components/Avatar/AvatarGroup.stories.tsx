import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from './Avatar.tsx'
import { AvatarGroup } from './AvatarGroup.tsx'
import { Card, CardBody } from '../Card/Card.tsx'

// AvatarGroup — an overlapping cluster of Avatars, each separated from the one
// beneath by a token ring so the stack reads as distinct faces. The ring color
// tracks the `surface` the cluster sits on (`'bg'` page default / `'surface'` on
// a Card) so it matches the background instead of haloing. When the child count
// exceeds `max`, the first `max` render and a trailing `+N` overflow chip stands
// in for the rest.

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

// On a Card — the cluster passes `surface="surface"` so the overlap ring matches
// the card background (`ring-surface`) instead of the page (`ring-bg`); without
// it the ring would read as a faint mismatched halo on the surface.
export const OnCard: Story = {
  render: () => (
    <Card>
      <CardBody>
        <AvatarGroup max={4} surface="surface">
          {PEOPLE.map((n) => (
            <Avatar key={n} name={n} />
          ))}
        </AvatarGroup>
      </CardBody>
    </Card>
  ),
}

// Small overflow — the campaign-card foot imprint: `sm` seals on a Card. The
// group passes `size="sm"` so the `+N` chip sizes to the SAME 32px control token
// as the seals; the chip sits flush in the row instead of towering over them (the
// bug this specimen exists to catch). Pass the SAME `size` to the group and the
// child Avatars.
export const SmallOverflow: Story = {
  render: () => (
    <Card>
      <CardBody>
        <AvatarGroup max={3} surface="surface" size="sm">
          {PEOPLE.map((n) => (
            <Avatar key={n} name={n} size="sm" />
          ))}
        </AvatarGroup>
      </CardBody>
    </Card>
  ),
}
