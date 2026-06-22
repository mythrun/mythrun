import type { Meta, StoryObj } from '@storybook/react-vite'
import { Grid } from './Grid.tsx'

// Grid — the CSS-grid layout primitive. Either a fixed equal-column count or a
// responsive `auto-fit` track sized off a --space minimum column width. Gap is
// on the --space scale. Use it instead of raw grid utilities so the layout
// stays token-spaced and ports to native.

const meta: Meta<typeof Grid> = {
  title: 'Layout/Grid',
  component: Grid,
  tags: ['autodocs'],
  argTypes: {
    columns: { control: 'text', description: 'A number, or "auto-fit"' },
    gap: { control: 'select', options: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    minColumnWidth: { control: 'select', options: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Grid>

function Cell({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <div className="bg-surface border border-border-strong px-[var(--space-3)] py-[var(--space-2)] text-center font-ui text-sm text-ink">
      {label}
    </div>
  )
}

const cells = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i + 1)

export const FixedColumns: Story = {
  name: 'Fixed columns',
  args: { columns: 3, gap: 3 },
  render: (args) => (
    <Grid {...args}>
      {cells(6).map((n) => (
        <Cell key={n} label={`Cell ${String(n)}`} />
      ))}
    </Grid>
  ),
}

export const AutoFit: Story = {
  name: 'Auto-fit track',
  args: { columns: 'auto-fit', minColumnWidth: 9, gap: 3 },
  render: (args) => (
    <div className="w-[480px]">
      <Grid {...args}>
        {cells(8).map((n) => (
          <Cell key={n} label={`Cell ${String(n)}`} />
        ))}
      </Grid>
    </div>
  ),
}
