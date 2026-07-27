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
  // Opens at MIN so the demo fits a 375px viewport: the docked panel is
  // `shrink-0` by design (it is what the handle resizes), so 340 + handle +
  // page padding overflowed mobile at 416px. Dragging still walks it to MAX.
  const [width, setWidth] = useState(MIN)
  return (
    <div className="flex min-h-dvh bg-bg p-[var(--space-6)]">
      {/* The explanatory column collapses below `sm`. A drag-to-resize side rail
          is a pointer pattern; at 375px the docked panel (shrink-0, since it is
          what the handle resizes) plus the page chrome leaves this column ~27px,
          which squeezed its own text out of its box. Hiding the prose rather
          than truncating it keeps the story honest about what the component is
          for, instead of showing a clipped sentence nobody would ship. */}
      <div className="hidden min-w-0 flex-1 p-[var(--space-4)] font-body text-ink sm:block">
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
