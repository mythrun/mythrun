import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  FOG_PARAM_RANGES,
  FOG_PARAMS,
  MIN_EXPECTED_ENTITIES,
  terrainSeedFor,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '@mythrun/client-core/worldgen'
import type { FogFieldEntity } from '@mythrun/client-core/contract'
import { WorldGenFogField } from './WorldGenFogField.tsx'

// WorldGenFogField — the decorative fog layer of the world-gen loading experience: rolling
// clouds that part/close around the streaming entity labels and DRAIN to nothing as the
// entities arrive (MYT-89 spawn-drain: the respawn flux scales down with the entity
// count and the wind carries the rest off the pane — the fog visibly BLOWS OFF, never
// dims). These specimens feed the reference's synthetic entity set and expose the two
// knobs — DENSITY (paint thickness) and the shown-ENTITY count, which drives both the
// obstacles the fog routes around AND the spawn scale against the REAL production
// denominator (`MIN_EXPECTED_ENTITIES`): slide it to the floor and the field empties
// exactly as a live generation's would. The fog canvas is aria-hidden decoration; in
// production it sits BEHIND the graph canvas (§5).

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

/** The tuning harness: DENSITY + arrived-ENTITY sliders. The entity slider drives the
 *  SPAWN SCALE against the real production denominator — `shown/MIN_EXPECTED_ENTITIES`
 *  (the DB-derived floor a real generation always reaches) — so at the slider's max the
 *  respawn flux is ZERO and the wind drains the field empty, exactly the live arc. The
 *  first N fixture entities double as the obstacles the fog routes around (the fixture
 *  set is smaller than the floor, so past `TOTAL` only the scale keeps falling). */
function FogTuner({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const [density, setDensity] = useState<number>(FOG_PARAMS.density)
  const [shown, setShown] = useState<number>(FOG_PARAMS.entities)

  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto flex max-w-[900px] flex-col gap-[var(--space-3)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          <Slider
            label="density"
            min={FOG_PARAM_RANGES.density.min}
            max={FOG_PARAM_RANGES.density.max}
            step={FOG_PARAM_RANGES.density.step}
            value={density}
            onChange={setDensity}
            readout={density.toFixed(2)}
          />
          <Slider
            label="entities"
            min={FOG_PARAM_RANGES.entities.min}
            max={MIN_EXPECTED_ENTITIES}
            step={FOG_PARAM_RANGES.entities.step}
            value={shown}
            onChange={(v) => {
              setShown(Math.round(v))
            }}
            readout={`${String(shown)}/${String(MIN_EXPECTED_ENTITIES)}`}
          />
        </div>
        {/* Pinned to the reference's exact 900×470 (see FogStage) — the tuner is the
            canonical look-check surface, not a responsive specimen. */}
        <div className="relative h-[470px] w-[900px] overflow-hidden bg-bg">
          <WorldGenFogField
            entities={ENTS.slice(0, Math.min(shown, TOTAL))}
            shownEntities={shown}
            totalEntities={MIN_EXPECTED_ENTITIES}
            density={density}
            {...(reducedMotion !== undefined ? { reducedMotion } : {})}
          />
        </div>
      </div>
    </div>
  )
}

// The tuning surface — slide ENTITIES toward the floor and watch the fog re-route,
// thin (fewer particles spawning in), and finally BLOW OFF the pane entirely.
export const Tuning: Story = {
  render: () => <FogTuner />,
  // The tuner mirrors the eye-tuned reference at its native 900px — a
  // wide-by-design dev harness, exempt from the 375px overflow gate.
  parameters: { overflowGate: false },
}

// The fog at rest with the locked defaults (a quick read of the settled look).
export const Locked: Story = {
  render: () => (
    <FogStage>
      <WorldGenFogField
        entities={ENTS.slice(0, FOG_PARAMS.entities)}
        shownEntities={FOG_PARAMS.entities}
        totalEntities={MIN_EXPECTED_ENTITIES}
      />
    </FogStage>
  ),
  // The fixed reference-size stage (900×470) — wide-by-design specimen.
  parameters: { overflowGate: false },
}

// Reduced motion: no rAF churn — the sim snaps to the CURRENT scaled population,
// settles to convergence, and repaints only when the entity count changes. The
// drain-with-entities progress signal is preserved (a static sample of the drain).
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  render: () => <FogTuner reducedMotion />,
  // Same 900px tuner harness — wide-by-design, gate-exempt.
  parameters: { overflowGate: false },
}

// The SEEDED GROUND (ux-run3 myth-rlbku + myth-llqj7). With a `terrainSeed` the layer
// stops being weather alone: a static landmass field is drawn under the drain, so the
// tiles cohere into a coastline against negative-space sea, the lower band of the pane
// carries world instead of dead paper, and the field is dense enough over land to clear
// a true 3:1 against the page ground (measured off rendered pixels in
// terrain-contrast.test.ts). The seed is derived from the campaign, so one world always
// draws the same coastline — this story fixes one so the specimen is stable.
//
// FULLY DRAINED: the fog has blown off and only the ground remains, which is what the
// player reads for most of the generation and the whole of the reveal.
export const SeededTerrain: Story = {
  name: 'Seeded terrain (drained)',
  render: () => (
    <FogStage>
      <WorldGenFogField
        entities={ENTS.slice(0, FOG_PARAMS.entities)}
        shownEntities={MIN_EXPECTED_ENTITIES}
        totalEntities={MIN_EXPECTED_ENTITIES}
        terrainSeed={terrainSeedFor('story-world')}
      />
    </FogStage>
  ),
  parameters: { overflowGate: false },
}

// The same seed mid-generation: the weather still rolling over its own ground. The
// coastline underneath is identical to the story above — that is the point.
export const SeededTerrainWithFog: Story = {
  name: 'Seeded terrain (fog still rolling)',
  render: () => (
    <FogStage>
      <WorldGenFogField
        entities={ENTS.slice(0, FOG_PARAMS.entities)}
        shownEntities={Math.round(MIN_EXPECTED_ENTITIES / 3)}
        totalEntities={MIN_EXPECTED_ENTITIES}
        terrainSeed={terrainSeedFor('story-world')}
      />
    </FogStage>
  ),
  parameters: { overflowGate: false },
}
