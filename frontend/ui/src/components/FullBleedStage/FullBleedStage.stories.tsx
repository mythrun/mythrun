import type { Meta, StoryObj } from '@storybook/react-vite'
import { FullBleedStage } from './FullBleedStage.tsx'

// FullBleedStage — the narrow-viewport full-screen stage (MYT-89 audit v2).
// Inside a framed page (header bar above, token-padded content box around), the
// stage on a phone-class viewport (< 640px) cancels the host's content inset and
// fills the viewport below the header — so a pannable surface (the world-gen
// graph) owns the screen: header + stage = exactly one viewport, no dead paper,
// no page scroll. On a wide viewport it is a plain block: the framed layout
// renders exactly as if the stage weren't there.
//
// VIEW THE SPECIMEN AT BOTH REGIMES (drag the viewport across 640px): wide shows
// the framed, inset content; narrow shows the stage bleeding to the edges and
// its child column filling to the fold.

const meta: Meta<typeof FullBleedStage> = {
  title: 'Layout/FullBleedStage',
  component: FullBleedStage,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof FullBleedStage>

// A mock of the app frame's chrome: a bordered header row + the `--space-6`
// padded content box (the SAME step the stage's `inset={6}` cancels).
function FramedPage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-bg">
      <div className="flex items-baseline justify-between border-b border-border-strong bg-surface p-[var(--space-4)] font-ui text-sm text-ink">
        <span>[ph: wordmark]</span>
        <span>[ph: chrome]</span>
      </div>
      <div className="bg-surface p-[var(--space-6)]">{children}</div>
    </div>
  )
}

// The stage inside the framed page. Its child column is marked with a border so
// the bleed is visible: wide = inset inside the frame padding; narrow = the
// border kisses the viewport edges and the column runs to the fold.
export const InAFrame: Story = {
  name: 'In a framed page (resize across 640px)',
  render: () => (
    <FramedPage>
      <FullBleedStage inset={6}>
        <div className="flex min-h-[16rem] flex-1 flex-col border border-border-strong">
          <div className="flex-1 p-[var(--space-4)] font-body text-sm text-ink">
            [ph: the stage content — a full-height column on narrow viewports]
          </div>
          <div className="border-t border-border-strong p-[var(--space-3)] font-ui text-xs text-ink-secondary">
            [ph: a footer bar pinned to the fold on narrow viewports]
          </div>
        </div>
      </FullBleedStage>
    </FramedPage>
  ),
}
