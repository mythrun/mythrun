import type { Meta, StoryObj } from '@storybook/react-vite'
import { ToastProvider } from './Toast.tsx'
import { toast } from './toast-store.ts'
import { Button } from '../Button/Button.tsx'

// Toast — a TRANSIENT, app-global notification surface. The web impl wraps Radix
// `Toast`: the Provider renders a STANDING live region (it exists before any
// toast, so an appended toast announces into a region that already exists — the
// #1 toast a11y bug avoided) plus a positioned `--z-toast` viewport. Radix owns
// auto-dismiss (`duration`), keyboard focus (F8), and swipe; the store owns the
// imperative `toast()` API, a dedupe window, and the max-visible cap.
//
// Motion (§4): enter/leave is OPACITY-ONLY; reduced motion still appears/removes.
// Flat 1-bit (§3): `--surface-raised` + a 1px `--border-{severity}` edge, no shadow.
// §4 status-intent: the severity color carries the ICON only; title + description
// are `--ink`.
//
// USAGE: mount ONE <ToastProvider> at the app root, then call `toast(options)`
// from anywhere. These stories mount the provider locally and fire `toast()` from
// buttons so the subsystem is interactive in the docs.
// Content/i18n: title/description/closeLabel are i18n keys the consumer resolves.

const meta: Meta<typeof ToastProvider> = {
  title: 'Feedback/Toast',
  component: ToastProvider,
  tags: ['autodocs'],
  args: {
    closeLabel: 'action.dismiss',
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof ToastProvider>

// Interactive — one button per severity fires `toast()`. The provider renders the
// queue in the bottom-right viewport; toasts auto-dismiss and can be closed.
export const Interactive: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-[var(--space-2)] p-[var(--space-4)]">
      <Button
        variant="secondary"
        onPress={() => toast({ severity: 'success', title: 'toast.success.title', description: 'toast.success.detail' })}
      >
        toast.fire.success
      </Button>
      <Button
        variant="secondary"
        onPress={() => toast({ severity: 'info', title: 'toast.info.title', description: 'toast.info.detail' })}
      >
        toast.fire.info
      </Button>
      <Button
        variant="secondary"
        onPress={() => toast({ severity: 'warning', title: 'toast.warning.title', description: 'toast.warning.detail' })}
      >
        toast.fire.warning
      </Button>
      <Button
        variant="secondary"
        onPress={() => toast({ severity: 'danger', title: 'toast.danger.title', description: 'toast.danger.detail' })}
      >
        toast.fire.danger
      </Button>
      <ToastProvider {...args} />
    </div>
  ),
}
