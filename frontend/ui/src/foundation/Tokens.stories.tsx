import type { Meta, StoryObj } from '@storybook/react-vite'

// Foundation specimen: NOT a library component (lives in src/foundation/, not
// src/components/), so it is exempt from the later story-coverage gate. Its job
// is to prove the harness wiring — if these token utilities resolve to the
// generated palette + semantic vars, Tailwind v4 + @mythrun/ui/styles.css are
// correctly compiled inside Storybook.

interface Swatch {
  readonly className: string
  readonly label: string
}

const PALETTE: readonly Swatch[] = [
  { className: 'bg-paper-100', label: 'paper-100' },
  { className: 'bg-paper-500', label: 'paper-500' },
  { className: 'bg-paper-900', label: 'paper-900' },
  { className: 'bg-ember-400', label: 'ember-400' },
  { className: 'bg-ember-600', label: 'ember-600' },
  { className: 'bg-success-500', label: 'success-500' },
  { className: 'bg-warning-500', label: 'warning-500' },
  { className: 'bg-danger-500', label: 'danger-500' },
  { className: 'bg-info-600', label: 'info-600' },
]

function TokenSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="font-ui text-sm text-ink-secondary">Palette</h2>
        <div className="flex flex-wrap gap-3">
          {PALETTE.map((s) => (
            <div key={s.label} className="flex flex-col items-center gap-1">
              <div className={`h-12 w-12 border border-border-strong ${s.className}`} />
              <span className="font-ui text-xs text-ink-tertiary">{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-ui text-sm text-ink-secondary">Type roles</h2>
        <p className="font-body text-2xl text-ink">Narrative serif display — the prose voice.</p>
        <p className="font-body text-base text-ink-secondary">
          Body copy on paper. Sensory detail, distinct NPC voices, tonal variety.
        </p>
        <p className="font-ui text-sm text-ink-tertiary">Mono UI chrome / metadata.</p>
        <p className="font-ui text-base text-accent">Accent ember — interactive emphasis.</p>
      </section>
    </div>
  )
}

const meta: Meta<typeof TokenSpecimen> = {
  title: 'Foundation/Tokens',
  component: TokenSpecimen,
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof TokenSpecimen>

export const Default: Story = {}
