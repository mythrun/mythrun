import type { Meta, StoryObj } from '@storybook/react-vite'
import { NoticeStrip } from './NoticeStrip.tsx'

// NoticeStrip — the sitewide outage notice (outage-resilience design §4.2): a
// slim full-width quiet prose strip that AppFrame seats directly under the
// sticky bar. Chrome type role, secondary ink, hairline --border top edge —
// no icons/dots/chips, no dismiss; the state is one line of prose.
//
// The host is a PERMANENTLY-MOUNTED role="status" live region (an already-
// populated status node is unreliably announced), so the Rest specimen is not
// "nothing": the live region is in the DOM at zero height — the stand-in rows
// around it prove the collapsed strip has zero visual footprint.

const meta: Meta<typeof NoticeStrip> = {
  title: 'Feedback/NoticeStrip',
  component: NoticeStrip,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  // Every specimen seats the strip in its real position: between a stand-in
  // bar row and page content (AppFrame mounts it under the StickyBar).
  render: (args) => (
    <div className="bg-surface">
      <div className="px-[var(--space-6)] py-[var(--space-3)] font-ui text-sm text-ink">
        [placeholder for the sticky bar row]
      </div>
      <NoticeStrip {...args} />
      <div className="px-[var(--space-6)] py-[var(--space-3)] font-body text-base text-ink">
        [placeholder for page content — while the strip is collapsed, nothing separates this from
        the bar row above]
      </div>
    </div>
  ),
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof NoticeStrip>

// Rest — collapsed: message null, the live-region host mounted at zero height.
// The two placeholder rows sit flush; the strip contributes no hairline, no
// inset, no gap.
export const Rest: Story = {
  args: { message: null },
}

// Degraded — the one quiet prose line, hairline top edge, gutter-aligned with
// the bar. The message is long enough that the 375px sweep exercises the
// two-line wrap.
export const Degraded: Story = {
  args: {
    message:
      '[placeholder for the sitewide outage notice, one quiet line long enough that a phone viewport wraps it onto a second row]',
  },
}

// Dark theme, degraded — story-level `globals` locks the theme toolbar to dark
// (the Menu DarkOpenHighlight precedent): secondary ink + hairline over the
// dark paper surface.
export const DegradedDark: Story = {
  globals: { theme: 'dark' },
  args: {
    message:
      '[placeholder for the sitewide outage notice, one quiet line long enough that a phone viewport wraps it onto a second row]',
  },
}
