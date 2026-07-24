import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ResizeHandle } from './ResizeHandle.tsx'

// ResizeHandle — the draggable vertical divider that resizes a docked panel. Drag
// the rule (or focus it and use ← / →) to widen or narrow the right-hand panel.

const meta: Meta<typeof ResizeHandle> = {
  title: 'Primitives/ResizeHandle',
  component: ResizeHandle,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof ResizeHandle>

const MIN = 240
const MAX = 520

function ResizableRail(): React.JSX.Element {
  const [width, setWidth] = useState(340)
  return (
    <div className="flex min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="min-w-0 flex-1 p-[var(--space-4)] font-body text-ink">
        <p>The main column. Drag the divider on the right — or focus it and press ← / → — to resize the panel.</p>
      </div>
      <ResizeHandle value={width} min={MIN} max={MAX} onChange={setWidth} edge="leading" label="Resize the panel" />
      <div
        style={{ width: `${String(width)}px` }}
        className="shrink-0 rounded-none border border-border-strong bg-surface p-[var(--space-4)] font-body text-ink"
      >
        <p>The docked panel, {Math.round(width)}px wide.</p>
      </div>
    </div>
  )
}

export const Default: Story = {
  render: () => <ResizableRail />,
}
