import type { Meta, StoryObj } from '@storybook/react-vite'
import { Modal } from './Modal.tsx'
import { Button } from '../Button/Button.tsx'
import { Text } from '../Text/Text.tsx'

// Modal — the dialog overlay. Wraps the unstyled Radix `Dialog` primitive (focus
// TRAP, focus-RETURN to the trigger on close, Esc-to-close, scroll lock, a
// portalled overlay + panel, ARIA `dialog` wiring), styled 100% with our tokens.
// The PANEL sits on the `--surface-overlay` modal tier with a 1px `--border-strong`
// edge (flat 1-bit: 0px radius, no shadow — depth via the surface tier + the
// `--scrim` veil). Layering: scrim `--z-overlay` (1200), panel `--z-modal` (1300).
//
// The `title` is the REQUIRED accessible name (→ `aria-labelledby`); `description`
// (optional) wires `aria-describedby`. The close control is a labelled IconButton.
// Open/close is the neutral `onOpenChange(open)` boolean (§9). Content/i18n: title,
// description, and closeLabel are i18n keys the consumer resolves.

const meta: Meta<typeof Modal> = {
  title: 'Overlays/Modal',
  component: Modal,
  tags: ['autodocs'],
  args: {
    title: 'modal.confirm_title',
    closeLabel: 'action.close',
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Modal>

// Default — opens from a Button trigger; the panel holds arbitrary content.
export const Default: Story = {
  args: {
    trigger: <Button>action.open</Button>,
    children: <Text>[placeholder for modal body copy]</Text>,
  },
}

// With a description — wired to `aria-describedby` and rendered under the title.
export const WithDescription: Story = {
  args: {
    description: 'modal.confirm_description',
    trigger: <Button>action.open</Button>,
    children: <Text>[placeholder for modal body copy]</Text>,
  },
}

// A flow the user must explicitly complete — scrim-click does NOT dismiss; the
// only exits are the close button and Esc, plus the in-panel actions.
export const NoScrimDismiss: Story = {
  args: {
    closeOnScrimClick: false,
    trigger: <Button>action.delete</Button>,
    children: (
      <div className="flex flex-col gap-[var(--space-4)]">
        <Text>[placeholder for destructive-action confirmation copy]</Text>
        <div className="flex justify-end gap-[var(--space-2)]">
          <Button variant="secondary">action.cancel</Button>
          <Button>action.confirm</Button>
        </div>
      </div>
    ),
  },
}

// Open by default — shows the open state in the catalogue without interaction.
export const OpenByDefault: Story = {
  args: {
    defaultOpen: true,
    trigger: <Button>action.open</Button>,
    children: <Text>[placeholder for modal body copy]</Text>,
  },
}
