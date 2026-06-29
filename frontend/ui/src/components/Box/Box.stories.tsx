import type { Meta, StoryObj } from '@storybook/react-vite'
import { Box } from './Box.tsx'

// Box — the generic surface container. A token-padded panel on one of the
// elevation surfaces (base / raised / overlay) OR the reversed (dark) surface,
// optionally bordered with the interactive-grade --border-strong, optionally
// floored to the full viewport (minHeight="screen"). The building block for
// cards, panels, and full-screen roots.

const meta: Meta<typeof Box> = {
  title: 'Layout/Box',
  component: Box,
  tags: ['autodocs'],
  argTypes: {
    as: { control: 'select', options: ['div', 'nav', 'main', 'footer', 'header', 'section'] },
    padding: { control: 'select', options: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    surface: { control: 'inline-radio', options: ['base', 'raised', 'overlay', 'reversed'] },
    border: { control: 'boolean' },
    minHeight: { control: 'inline-radio', options: [undefined, 'screen'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Box>

export const Default: Story = {
  args: { padding: 4, surface: 'base' },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm text-ink">Base surface, padding 4</span>
    </Box>
  ),
}

export const Bordered: Story = {
  args: { padding: 4, surface: 'base', border: true },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm text-ink">Bordered panel</span>
    </Box>
  ),
}

export const Surfaces: Story = {
  name: 'Elevation surfaces',
  render: () => (
    <div className="flex flex-col gap-[var(--space-3)]">
      <Box padding={4} surface="base" border>
        <span className="font-ui text-sm text-ink">base · --surface</span>
      </Box>
      <Box padding={4} surface="raised" border>
        <span className="font-ui text-sm text-ink">raised · --surface-raised (popover)</span>
      </Box>
      <Box padding={4} surface="overlay" border>
        <span className="font-ui text-sm text-ink">overlay · --surface-overlay (modal)</span>
      </Box>
    </div>
  ),
}

// The reversed (dark) surface. `surface="reversed"` makes the Box a `.dark`
// region: its bg flips to dark paper-900 and inherited text flips to the light
// `--ink` (paper-100) — the same inversion the page→footer break uses. NO
// explicit text color on the child: it INHERITS the flipped light ink (a
// hardcoded `text-ink` would resolve to the frozen dark value and go invisible).
export const Reversed: Story = {
  name: 'Reversed (dark) surface',
  args: { padding: 4, surface: 'reversed' },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm">reversed · dark paper-900, light-on-dark text</span>
    </Box>
  ),
}

// Semantic landmark. `as` swaps the rendered element from the default `<div>`
// to a page-landmark tag (`nav` / `main` / `footer` / `header` / `section`) —
// surface/padding/border behaviour is unchanged. The landing page's nav/main/
// footer consume this so the markup carries real landmark roles.
export const Landmark: Story = {
  args: { as: 'section', surface: 'raised', padding: 5, children: 'A section landmark' },
}

// Full-viewport floor. `minHeight="screen"` floors the Box at 100dvh (the
// DYNAMIC viewport — fills the screen on mobile and desktop alike, where 100vh
// would leave a strip of canvas at the bottom on mobile once the URL bar hides)
// — a full-screen root (e.g. the dithered 404). Shown here on the reversed
// surface, the combination the 404 uses: the dark surface fills the whole viewport.
export const FullScreen: Story = {
  name: 'Full-screen root (minHeight=screen)',
  args: { padding: 6, surface: 'reversed', minHeight: 'screen' },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm">
        minHeight=&quot;screen&quot; · fills the viewport (dark, full-bleed)
      </span>
    </Box>
  ),
}
