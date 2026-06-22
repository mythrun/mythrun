import type { Meta, StoryObj } from '@storybook/react-vite'
import { Banner } from './Banner.tsx'

// Banner — an INLINE, PERSISTENT status message that sits in the document flow
// (a form-level error, a degraded-mode notice, a success confirmation). Flat
// 1-bit register (§3): `rounded-none`, a 1px `--border-{severity}` edge over a
// faint `--surface-{severity}` tint, no shadow.
//
// §4 status-intent (the load-bearing rule): the SEVERITY COLOR carries the ICON
// only; BODY TEXT is always `--ink` (coloring body copy with the status token
// fails AA on the light tint). a11y: success/info announce politely
// (`role="status"`), warning/danger assertively (`role="alert"`) — the severity
// drives the urgency. `dismissible` adds a labelled close IconButton.
//
// Do: use for status the user should keep seeing until they act/move on; pick the
//   severity that matches the meaning, not the desired color.
// Don't: use it for transient feedback (use the Toast subsystem); never color the
//   body text with the status token.
// Content/i18n: `title`/`children`/`dismissLabel` are i18n keys the consumer resolves.

const meta: Meta<typeof Banner> = {
  title: 'Feedback/Banner',
  component: Banner,
  tags: ['autodocs'],
  argTypes: {
    severity: { control: 'inline-radio', options: ['success', 'warning', 'danger', 'info'] },
    title: { control: 'text' },
    dismissible: { control: 'boolean' },
  },
  args: {
    severity: 'info',
    title: 'banner.title',
    children: '[placeholder for banner body copy]',
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Banner>

export const Default: Story = {}

// All four severities stacked — each shows its token border + tinted glyph + the
// polite/assertive role mapping. Body copy stays `--ink` across all four.
export const Severities: Story = {
  render: () => (
    <div className="flex w-[28rem] max-w-full flex-col gap-[var(--space-3)]">
      <Banner severity="success" title="banner.success.title">
        [placeholder for success body copy]
      </Banner>
      <Banner severity="info" title="banner.info.title">
        [placeholder for info body copy]
      </Banner>
      <Banner severity="warning" title="banner.warning.title">
        [placeholder for warning body copy]
      </Banner>
      <Banner severity="danger" title="banner.danger.title">
        [placeholder for danger body copy]
      </Banner>
    </div>
  ),
}

// A single-line banner (no title) — the body is the whole message.
export const BodyOnly: Story = {
  render: () => <Banner severity="warning">[placeholder for single-line notice]</Banner>,
}

// Dismissible — a labelled close IconButton calls `onDismiss`.
export const Dismissible: Story = {
  args: {
    severity: 'danger',
    title: 'banner.error.title',
    children: '[placeholder for dismissible error copy]',
    dismissible: true,
    dismissLabel: 'action.dismiss',
  },
}
