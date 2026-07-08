import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Drawer } from './Drawer.tsx'
import { Button } from '../Button/Button.tsx'
import { Text } from '../Text/Text.tsx'

// Drawer — the edge-handle side sheet (MYT-89 Phase D). A full-width paper
// sheet sliding in from the right, summoned/dismissed by the handle pinned at
// the right edge (same spot both states: ‹ summon, › dismiss). Built for the
// mobile world-reveal: the graph owns the screen, the wiki lives in here.
//
// MOUNT-PERSISTENT: children keep their state across close/open — the sheet
// slides off-screen (transform + inert), it never unmounts. The counter below
// is the proof: open, click it a few times, close, reopen — the count survives.
// Layering mirrors Modal: sheet on `--surface-overlay` at `--z-modal`, scrim at
// `--z-overlay`. Esc dismisses; focus moves in on open and returns to the
// handle on close. Reduced motion renders the end states with no slide.

// A stateful specimen — demonstrates that closing the drawer does not reset
// its children (the D3 wiki's navigation/scroll state rides on this).
function PersistenceProbe() {
  const [count, setCount] = useState(0)
  return (
    <div className="flex flex-col items-start gap-[var(--space-3)]">
      <Text>[placeholder for drawer body copy — close and reopen: the count below survives]</Text>
      <Button
        variant="secondary"
        onPress={() => {
          setCount((c) => c + 1)
        }}
      >
        demo.count · {count}
      </Button>
    </div>
  )
}

const meta: Meta<typeof Drawer> = {
  title: 'Patterns/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  args: {
    title: 'drawer.title',
    openLabel: 'drawer.open',
    closeLabel: 'drawer.close',
  },
  // A mobile-first surface — catalogue it at phone width by default. The
  // 375/1280 overflow sweep still gates both breakpoints regardless.
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Drawer>

// Default — closed: the whole affordance is the quiet paper tab at the right
// edge. The play() drives the persistence journey itself (open → count to 2 →
// close → reopen → the count SURVIVED), so the browser sweep proves
// mount-persistence in real Chromium on every CI run. It ends by closing
// again, leaving the closed resting state as the catalogue specimen. The
// drawer portals to document.body, so queries scope there, not canvasElement.
export const Default: Story = {
  args: {
    children: <PersistenceProbe />,
  },
  play: async () => {
    const body = within(document.body)
    await userEvent.click(body.getByRole('button', { name: 'drawer.open' }))
    const probe = body.getByRole('button', { name: /demo\.count/ })
    await userEvent.click(probe)
    await userEvent.click(probe)
    await expect(body.getByText('demo.count · 2')).toBeInTheDocument()
    // Close — the probe must STAY MOUNTED (state alive), just hidden + inert.
    await userEvent.click(body.getByRole('button', { name: 'drawer.close' }))
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument())
    await expect(body.getByText('demo.count · 2')).toBeInTheDocument()
    // Reopen — the count resumes from 2, not 0. THE persistence assertion.
    await userEvent.click(body.getByRole('button', { name: 'drawer.open' }))
    await waitFor(() => expect(body.getByRole('dialog')).toBeInTheDocument())
    await expect(body.getByText('demo.count · 2')).toBeInTheDocument()
    // Rest closed — Default stays the closed-state specimen.
    await userEvent.click(body.getByRole('button', { name: 'drawer.close' }))
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument())
  },
}

// Open — the sheet as it stands revealed: full-width paper, hard left edge,
// serif title, the handle flipped to dismiss in the same spot. The overflow
// gate asserts the portalled sheet is attached, then measures it at 375/1280.
export const Open: Story = {
  parameters: { overflowGate: { openSelector: '[role="dialog"]' } },
  args: {
    defaultOpen: true,
    description: 'drawer.description',
    children: <PersistenceProbe />,
  },
}
