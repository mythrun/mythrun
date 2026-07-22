import type { Meta, StoryObj } from '@storybook/react-vite'
import { SituationRecap } from './SituationRecap.tsx'

// SituationRecap — the quiet paper card that keeps the chosen opening situation in
// view while the player writes their character (mounted above the create prompts).
// Mono eyebrow (resolved chrome), serif title + location, scene prose. Long prose
// clamps below the `sm` step with an internal disclosure toggle; short prose
// renders whole with no toggle. The specimens are realistic LLM-authored DATA
// (stories are lint-exempt); the consuming screen owns the reading measure, so
// these stories supply it (desktop column + the 375px phone frame).

const meta: Meta<typeof SituationRecap> = {
  title: 'Character/SituationRecap',
  component: SituationRecap,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SituationRecap>

const EYEBROW = 'Your opening scene'
const TITLE = 'The harbour at low tide'
const LOCATION = 'Ashfen Reach'
const SHORT_PROSE = 'A skiff has come in wrong, riding low with no one at the tiller.'
const LONG_PROSE =
  'A skiff has come in wrong, riding low with no one at the tiller. The harbourmaster has cleared the quay and stands alone at the bollard, rope in hand, watching the boat drift closer. ' +
  'Gulls have gone quiet. Someone will have to board her, and the tide gives you an hour at most before she is carried back out past the bar.'

// Desktop — the ambient card at the create screen's reading measure.
export const Default: Story = {
  name: 'Default (desktop)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <SituationRecap eyebrow={EYEBROW} title={TITLE} locationName={LOCATION} prose={SHORT_PROSE} />
    </div>
  ),
}

// Long prose — whole on desktop; below `sm` this same specimen clamps to three
// lines and grows the quiet disclosure toggle.
export const LongProse: Story = {
  name: 'Long prose',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <SituationRecap eyebrow={EYEBROW} title={TITLE} locationName={LOCATION} prose={LONG_PROSE} />
    </div>
  ),
}

// Phone — the clamped card + toggle at ~375px (the state the collapse exists for).
export const Phone: Story = {
  name: 'Phone (~375px, collapsible)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <SituationRecap eyebrow={EYEBROW} title={TITLE} locationName={LOCATION} prose={LONG_PROSE} />
    </div>
  ),
}
