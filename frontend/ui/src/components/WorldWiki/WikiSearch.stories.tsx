import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiSearch } from './WikiSearch.tsx'

// WikiSearch — the wiki's filter control: a body-scale borderless baseline field
// in the flat 1-bit paper register (no box, no pill), with a quiet secondary
// label above it. A working control, not a hero — its type sits at body scale,
// below the browse-by-kind group headings, so the wiki home reads as an honest
// ladder (world-name title → group headings → rows + this field → eyebrows).

const meta: Meta<typeof WikiSearch> = {
  title: 'Patterns/WorldWiki/WikiSearch',
  component: WikiSearch,
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

type Story = StoryObj<typeof WikiSearch>

/** Live specimen — typing updates the controlled value (the shell owns the query
 *  in the real wiki). */
function LiveSearch({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <WikiSearch
      label="[placeholder for the search field label]"
      value={value}
      onChange={setValue}
      placeholder="[placeholder for the search hint]"
    />
  )
}

// The resting field: the quiet label over the borderless baseline, the faint
// placeholder hint below.
export const Default: Story = {
  render: () => <LiveSearch />,
}

// A filled field: the query at body scale, ink not muted.
export const Filled: Story = {
  render: () => <LiveSearch initial="ward" />,
}
