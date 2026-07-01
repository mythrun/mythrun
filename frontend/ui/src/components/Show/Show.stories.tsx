import type { Meta, StoryObj } from '@storybook/react-vite'
import { Show } from './Show.tsx'

// Show — the responsive show/hide primitive. A breakpoint SWITCH for two visually
// distinct layouts that don't reflow into each other: render both, and let `above`
// / `below` decide which is visible. Resize the preview across the breakpoint to
// see the swap — the off-screen branch is `display:none` (out of the a11y tree).

const meta: Meta<typeof Show> = {
  title: 'Layout/Show',
  component: Show,
  tags: ['autodocs'],
  argTypes: {
    above: { control: 'select', options: [undefined, 'sm', 'md', 'lg', 'xl', '2xl'] },
    below: { control: 'select', options: [undefined, 'sm', 'md', 'lg', 'xl', '2xl'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Show>

function Panel({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <div className="border border-border-strong bg-surface px-[var(--space-4)] py-[var(--space-3)] text-center font-ui text-sm text-ink">
      {label}
    </div>
  )
}

// The hub's pattern: a desktop layout shown at/above `md`, a mobile layout shown
// below it. Exactly one is visible — drag the viewport across 768px to switch.
export const DesktopOrMobile: Story = {
  name: 'Desktop ⊕ mobile (switch at md)',
  parameters: { overflowGate: false },
  render: () => (
    <>
      <Show above="md">
        <Panel label="Desktop layout — shown at/above md (≥768px)" />
      </Show>
      <Show below="md">
        <Panel label="Mobile layout — shown below md (<768px)" />
      </Show>
    </>
  ),
}

export const Above: Story = {
  name: 'above (hidden below the step)',
  args: { above: 'lg' },
  render: (args) => (
    <Show {...args}>
      <Panel label="Visible at/above lg (≥1024px)" />
    </Show>
  ),
}

export const Below: Story = {
  name: 'below (hidden at/above the step)',
  args: { below: 'lg' },
  render: (args) => (
    <Show {...args}>
      <Panel label="Visible below lg (<1024px)" />
    </Show>
  ),
}
