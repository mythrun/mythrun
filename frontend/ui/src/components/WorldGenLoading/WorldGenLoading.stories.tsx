import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading — act ONE of the two-act generating flow. While the prep stages
// (concept_intake → world_color → vocabulary_intake, the first ~2 minutes) run,
// there is nothing to draw — so the player gets the DS Spinner (the brand dither
// wave) over a flavor line cycling short playful loading messages every ~3s
// (Claude-Code-"thinking" style; a hard swap — no animated transition). When
// entities start streaming, the "watch your world be born" reveal button appears:
// generation keeps running regardless; pressing it swaps the route to the graph
// view. Every string is a `[ph:]` i18n key (the DS owns no copy). Under
// prefers-reduced-motion the Spinner goes static and the cycler freezes on the
// first line.

const meta: Meta<typeof WorldGenLoading> = {
  title: 'Patterns/WorldGenLoading',
  component: WorldGenLoading,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenLoading>

const FLAVORS = [
  '[ph: worldgen flavor 1]',
  '[ph: worldgen flavor 2]',
  '[ph: worldgen flavor 3]',
  '[ph: worldgen flavor 4]',
  '[ph: worldgen flavor 5]',
  '[ph: worldgen flavor 6]',
]

// PREP — the pure act-one state: the Spinner + the cycling flavor line, no button.
// Watch the line rotate every ~3 seconds.
export const Prep: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading flavorLabels={FLAVORS} spinnerLabel="[ph: making your world]" />
    </div>
  ),
}

// REVEAL READY — entities have started streaming: the "watch your world be born"
// button appears (the deliberate beat). The flavor line keeps cycling — generation
// runs regardless; the button only swaps the view.
export const RevealReady: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel="[ph: making your world]"
        revealReady
        revealLabel="[ph: watch your world be born]"
        onReveal={() => {
          /* the route swaps to the graph view */
        }}
      />
    </div>
  ),
}

// SINGLE LINE — one flavor label: nothing to cycle, the line just holds.
export const SingleLine: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={['[ph: worldgen flavor 1]']}
        spinnerLabel="[ph: making your world]"
      />
    </div>
  ),
}
