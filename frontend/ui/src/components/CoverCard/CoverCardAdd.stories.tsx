import type { Meta, StoryObj } from '@storybook/react-vite'
import { CoverCardAdd } from './CoverCardAdd.tsx'
import { CoverCard } from './CoverCard.tsx'
import { CoverDither } from '../CoverDither/CoverDither.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Grid } from '../Grid/Grid.tsx'

// CoverCardAdd — the dashed "＋ New campaign" create tile that TRAILS the campaign-hub
// grid (MYT-3jb55; moved to the last cell by myth-z9eiq — the premier slot belongs to
// the player's most-recent campaign). Same 3:2 footprint as CoverCard, a peer cell.
// Toggle the toolbar THEME: the paper surface + dashed edge re-ink like the covers.

const meta: Meta<typeof CoverCardAdd> = {
  title: 'Containers/CoverCardAdd',
  component: CoverCardAdd,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CoverCardAdd>

// The tile on its own, at the card width.
export const Single: Story = {
  render: () => <CoverCardAdd width={230} label="New campaign" />,
}

// In situ — the create tile terminating a shelf of covers, the way the hub
// renders it: covers first (premier slot top-left), the ghost tile as the
// natural "+ one more" at the end.
export const TrailingTheShelf: Story = {
  render: () => (
    <Grid columns="auto-fill" minColumnPx={230} gap={4}>
      <CoverCard
        width={230}
        cover={<CoverDither size="band" from="lapis-100" to="slate-900" />}
        foot={null}
      >
        <Heading level={2} role="title">
          The Lapis Road
        </Heading>
      </CoverCard>
      <CoverCard
        width={230}
        cover={<CoverDither size="band" from="rose-100" to="rose-800" />}
        foot={null}
      >
        <Heading level={2} role="title">
          The Rose Assembly
        </Heading>
      </CoverCard>
      <CoverCardAdd width={230} label="New campaign" />
    </Grid>
  ),
}
