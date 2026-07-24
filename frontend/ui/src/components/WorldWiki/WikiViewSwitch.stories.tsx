import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiViewSwitch, type WikiView } from './WikiViewSwitch.tsx'

// WikiViewSwitch — the wiki's Index ⇄ Glossary segmented switch. A square,
// paper-register toggle group (deliberately not the underlined DS Tabs, which
// would nest badly inside the play sidebar's own tab bar).

const meta: Meta<typeof WikiViewSwitch> = {
  title: 'Patterns/WorldWiki/WikiViewSwitch',
  component: WikiViewSwitch,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-dvh bg-bg p-[var(--space-6)]">
        <div className="mx-auto max-w-sm">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WikiViewSwitch>

function LiveSwitch({ initial = 'index' }: { initial?: WikiView }): React.JSX.Element {
  const [view, setView] = useState<WikiView>(initial)
  return <WikiViewSwitch value={view} onChange={setView} indexLabel="Index" glossaryLabel="Glossary" />
}

export const Index: Story = {
  render: () => <LiveSwitch initial="index" />,
}

export const Glossary: Story = {
  render: () => <LiveSwitch initial="glossary" />,
}
