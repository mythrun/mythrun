import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { within, userEvent } from 'storybook/test'
import {
  ApiClientProvider,
  type ApiContext,
  type CharacterFull,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CharacterRevealSurface } from './character-reveal.tsx'

// CharacterRevealSurface — the "Meet your character" payoff (MYT-90 D6). The specimens
// feed the surface a RAW getCharacter response through the `getCharacter` seam, so the
// adapter (SRD maps + B4 sheetViewModel) reshapes real snake_case backend data into the
// DS <CharacterSheetReveal> WITHOUT a live backend. Martial = no spells; Caster = the
// "what they can cast" panel appears; Expanded clicks "See full sheet" (a pure client
// reveal — no network). The reveal component's own responsive/a11y sweep lives in
// @mythrun/ui; these exercise the D6 raw→sheet adaptation end-to-end.

const STORY_CID = 'story-campaign'
const STORY_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

const BASE: CharacterFull['character'] = {
  id: 'char-1',
  user_id: 'viewer',
  entity_id: null,
  name: 'Kessa Vurm',
  level: 3,
  class: 'Fighter',
  species: 'Human',
  background: 'Toll-clerk of Greenward',
  str: 16,
  dex: 13,
  con: 15,
  int: 12,
  wis: 11,
  cha: 9,
  hit_points: 28,
  max_hit_points: 28,
  armor_class: 16,
  proficiency_bonus: 2,
  gold: 9,
  hit_die: 10,
  hit_dice_remaining: 3,
  spellcasting_progression: 'none',
  created_at: '2026-07-11T10:00:00.000Z',
  updated_at: '2026-07-11T10:00:00.000Z',
}

const MARTIAL_RAW: CharacterFull = {
  character: BASE,
  skills: [
    { skill_name: 'Athletics', proficiency_level: 'proficient' },
    { skill_name: 'Intimidation', proficiency_level: 'expertise' },
    { skill_name: 'Perception', proficiency_level: 'proficient' },
    { skill_name: 'Arcana', proficiency_level: 'none' },
  ],
  features: [
    { feature_name: 'Second Wind', feature_source: 'Fighter', description: 'Catch her breath: recover a burst of HP once per rest.' },
    { feature_name: 'Action Surge', feature_source: 'Fighter', description: 'One extra action when it counts. Once per rest.' },
  ],
  equipment: [
    { item_name: 'Longsword', quantity: 1, equipped: true },
    { item_name: 'Chain mail', quantity: 1, equipped: true },
    { item_name: 'Javelin', quantity: 4, equipped: false },
  ],
  spells: [],
}

const CASTER_RAW: CharacterFull = {
  character: {
    ...BASE,
    name: 'Ilma the Unwritten',
    class: 'Wizard',
    species: 'Gnome',
    background: 'Runaway apprentice',
    str: 8,
    dex: 14,
    con: 13,
    int: 17,
    wis: 12,
    cha: 10,
    hit_points: 17,
    max_hit_points: 17,
    armor_class: 12,
    hit_die: 6,
    spellcasting_progression: 'full',
  },
  skills: [
    { skill_name: 'Arcana', proficiency_level: 'expertise' },
    { skill_name: 'History', proficiency_level: 'proficient' },
    { skill_name: 'Medicine', proficiency_level: 'none' },
  ],
  features: [
    { feature_name: 'Arcane Recovery', feature_source: 'Wizard', description: 'Recover spell slots on a short rest, once a day.' },
  ],
  equipment: [
    { item_name: 'Quarterstaff', quantity: 1, equipped: true },
    { item_name: 'Spellbook', quantity: 1, equipped: false },
  ],
  spells: [
    { spell_name: 'Fire Bolt', spell_level: 0, prepared: true },
    { spell_name: 'Mage Hand', spell_level: 0, prepared: true },
    { spell_name: 'Magic Missile', spell_level: 1, prepared: true },
    { spell_name: 'Misty Step', spell_level: 2, prepared: true },
  ],
}

function renderWith(raw: CharacterFull): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={STORY_CTX}>
        <CharacterRevealSurface
          campaignId={STORY_CID}
          charId={raw.character.id}
          onConfirmed={() => undefined}
          onReset={() => undefined}
          getCharacter={() => Promise.resolve(raw)}
        />
      </ApiClientProvider>
    </I18nextProvider>
  )
}

const meta: Meta<typeof CharacterRevealSurface> = {
  title: 'Screens/CharacterReveal',
  component: CharacterRevealSurface,
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterRevealSurface>

// Martial — a Fighter (no spells): the "what they can cast" panel is absent, and the
// stat stripe defaults Speed to 30 ft.
export const Martial: Story = {
  name: 'Martial (no spells)',
  render: () => renderWith(MARTIAL_RAW),
}

// Caster — a Wizard: the curated "what they can cast" panel appears (spells non-empty).
export const Caster: Story = {
  name: 'Caster (spells panel)',
  render: () => renderWith(CASTER_RAW),
}

// Expanded — the full mechanical sheet revealed by clicking "See full sheet" (a pure
// client reveal; no network). The play interaction drives the DS toggle.
export const Expanded: Story = {
  name: 'Expanded (full sheet)',
  render: () => renderWith(CASTER_RAW),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'See full sheet' }))
    await canvas.findByTestId('character-sheet-reveal-full')
  },
}
