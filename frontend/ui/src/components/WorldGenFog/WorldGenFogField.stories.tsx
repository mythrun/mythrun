import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  FOG_PARAM_RANGES,
  FOG_PARAMS,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity } from '@mythrun/client-core/contract'
import { WorldGenFogField } from './WorldGenFogField.tsx'

// WorldGenFogField — the decorative fog layer of the world-gen loading experience: rolling
// clouds that part/close around the streaming entity labels and fade to nothing as the
// graph fills. These specimens feed the reference's synthetic entity set and expose the
// two knobs Miklos dialled the fog in with — DENSITY (starting thickness) and the shown-
// ENTITY count (which drives both the obstacles the fog routes around AND the fade) — so
// the fog can be tuned in isolation, mirroring the prototype's tuning UI. The fog canvas
// is aria-hidden decoration; in production it sits BEHIND the graph canvas (§5).

const meta: Meta<typeof WorldGenFogField> = {
  title: 'Patterns/WorldGenFogField',
  component: WorldGenFogField,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenFogField>

// The reference `ENTS` — normalized positions × the virtual space, with kinds that size
// the markers (the obstacle capsule widths). Fixture names (like the graph story's) — the
// fog never renders them; they only set the measured label width the fog parts around.
const ENTS: FogFieldEntity[] = [
  { x: 0.3, y: 0.3, name: 'Stillwater', kind: 'LOCATION' },
  { x: 0.62, y: 0.38, name: 'Belltoe', kind: 'LOCATION' },
  { x: 0.44, y: 0.6, name: 'Bell-Wardens', kind: 'FACTION' },
  { x: 0.72, y: 0.7, name: 'Abbot Sennel', kind: 'NPC' },
  { x: 0.22, y: 0.78, name: 'The Understirring', kind: 'LOCATION' },
  { x: 0.82, y: 0.24, name: 'The Forgetting Road', kind: 'LOCATION' },
  { x: 0.52, y: 0.17, name: 'Lector Ivarn', kind: 'NPC' },
  { x: 0.13, y: 0.48, name: 'The Bell-Loft', kind: 'LOCATION' },
  { x: 0.6, y: 0.54, name: "Recollects' Circle", kind: 'FACTION' },
  { x: 0.37, y: 0.43, name: 'Master Peret Vell', kind: 'NPC' },
  { x: 0.8, y: 0.52, name: 'The Lower Galleries', kind: 'LOCATION' },
  { x: 0.47, y: 0.86, name: 'The Cracked Bowl', kind: 'LOCATION' },
].map((e) => ({ ...e, x: e.x * VIRTUAL_WIDTH, y: e.y * VIRTUAL_HEIGHT }))

const TOTAL = ENTS.length

/** The fog stage — a paper-toned box at EXACTLY the reference's 900×470 (the canonical
 *  box the fog was eye-tuned in; the `ENTS` fixture coords are absolute in that space).
 *  The production pane is responsive (`virtualDims` adapts the virtual space to the
 *  pane), but THIS tuning/reference surface stays pinned to the prototype's own dims so
 *  a look-check here diffs 1:1 against the reference. The fog canvas is `absolute
 *  inset-0` inside it, exactly how it layers behind the graph canvas. */
function FogStage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="relative mx-auto h-[470px] w-[900px] overflow-hidden bg-bg">
        {children}
      </div>
    </div>
  )
}

/** A tiny range control (dev tuning chrome — placeholder labels per the brand i18n rule). */
function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  readout: string
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-[var(--space-2)] font-mono text-[12px] text-ink">
      <span className="w-28">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          props.onChange(Number(e.target.value))
        }}
        className="flex-1"
      />
      <span className="w-10 text-right text-ink-secondary">{props.readout}</span>
    </label>
  )
}

/** The tuning harness: DENSITY + shown-ENTITY sliders driving the fog + its fade, mirroring
 *  the reference tuning UI. `shown` slices the first N entities as obstacles AND is the fade
 *  numerator (total = the full set), so raising it both re-routes the fog and thins it. */
function FogTuner({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const [density, setDensity] = useState<number>(FOG_PARAMS.density)
  const [shown, setShown] = useState<number>(FOG_PARAMS.entities)

  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto flex max-w-[900px] flex-col gap-[var(--space-3)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          <Slider
            label="[ph: density]"
            min={FOG_PARAM_RANGES.density.min}
            max={FOG_PARAM_RANGES.density.max}
            step={FOG_PARAM_RANGES.density.step}
            value={density}
            onChange={setDensity}
            readout={density.toFixed(2)}
          />
          <Slider
            label="[ph: entities]"
            min={FOG_PARAM_RANGES.entities.min}
            max={TOTAL}
            step={FOG_PARAM_RANGES.entities.step}
            value={shown}
            onChange={(v) => {
              setShown(Math.round(v))
            }}
            readout={`${String(shown)}/${String(TOTAL)}`}
          />
        </div>
        {/* Pinned to the reference's exact 900×470 (see FogStage) — the tuner is the
            canonical look-check surface, not a responsive specimen. */}
        <div className="relative h-[470px] w-[900px] overflow-hidden bg-bg">
          <WorldGenFogField
            entities={ENTS.slice(0, shown)}
            shownEntities={shown}
            totalEntities={TOTAL}
            density={density}
            {...(reducedMotion !== undefined ? { reducedMotion } : {})}
          />
        </div>
      </div>
    </div>
  )
}

// The tuning surface — slide DENSITY + ENTITIES and watch the fog re-route and fade.
export const Tuning: Story = {
  render: () => <FogTuner />,
}

// The fog at rest with the locked defaults (a quick read of the settled look).
export const Locked: Story = {
  render: () => (
    <FogStage>
      <WorldGenFogField
        entities={ENTS.slice(0, FOG_PARAMS.entities)}
        shownEntities={FOG_PARAMS.entities}
        totalEntities={TOTAL}
      />
    </FogStage>
  ),
}

// Reduced motion: no rAF churn — the density settles to convergence and repaints only when
// the entity count changes. The fade-with-entities progress signal is preserved (static).
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  render: () => <FogTuner reducedMotion />,
}
