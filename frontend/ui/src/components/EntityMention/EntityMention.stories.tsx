import type { Meta, StoryObj } from '@storybook/react-vite'
import { EntityMention } from './EntityMention.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// EntityMention — a recognized entity name highlighted inside SETTLED DM serif
// prose (MYT-94, spec §6). A real, focusable <button> reset to read as inline
// text; the EntityPopover wraps it to open the terse knowledge card.
//
// MONOCHROME by design (spec §6 — no NPC-blue / location-amber / faction-green):
// the ONLY differentiators are the underline STYLE and a leading type glyph.
//   • Rest — a subtle low-contrast DOTTED underline in the muted ink.
//   • Hover / focus — the style changes (dotted → solid) + darkens within ink,
//     and a small leading type glyph (person / pin / banner) fades in. The glyph
//     is absolutely positioned, so its reveal never reflows the paragraph.
// Two typefaces only: the mention stays `--font-body` (it lives in serif prose).
//
// Do: hover / tab to a mention to see the glyph + style change.
// Don't: expect any colour tint — the register is monochrome + CVD-safe.
// Content/i18n: `text` is DATA (the entity name from the model); `label` is the
//   resolved a11y "entity: <name>" key.

const meta: Meta<typeof EntityMention> = {
  title: 'Session/EntityMention',
  component: EntityMention,
  tags: ['autodocs'],
  argTypes: {
    text: { control: 'text' },
    glyph: { control: 'inline-radio', options: ['npc', 'location', 'faction', 'other'] },
    label: { control: 'text' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof EntityMention>

export const Default: Story = {
  args: { text: 'Elenya', glyph: 'npc', label: 'entity: Elenya' },
}

// The real context: mentions live INSIDE a settled serif-prose paragraph. Hover /
// tab through them to reveal each type glyph + the dotted→solid underline change.
export const InProse: Story = {
  render: () => (
    <div className="max-w-[42rem] text-ink">
      <p className={TYPE_ROLE_CLASS['prose-body']}>
        The lamps of{' '}
        <EntityMention text="Highreach" glyph="location" label="entity: Highreach" /> were still
        burning when{' '}
        <EntityMention text="Elenya" glyph="npc" label="entity: Elenya" /> slipped through the gate.
        Word had it the{' '}
        <EntityMention text="The Ashen Hand" glyph="faction" label="entity: The Ashen Hand" /> would
        not wait much longer.
      </p>
    </div>
  ),
}

// The three world-lore type glyphs side by side (npc / location / faction) plus
// the neutral `other` kind, which carries NO glyph — just the underlined name.
export const AllTypes: Story = {
  render: () => (
    <div className="flex flex-col gap-[var(--space-3)] text-ink">
      {(
        [
          ['npc', 'Elenya'],
          ['location', 'Highreach'],
          ['faction', 'The Ashen Hand'],
          ['other', 'a bone dagger'],
        ] as const
      ).map(([glyph, text]) => (
        <p key={glyph} className={TYPE_ROLE_CLASS['prose-body']}>
          <EntityMention text={text} glyph={glyph} label={`entity: ${text}`} /> — {glyph}
        </p>
      ))}
    </div>
  ),
}

// Narrow (mweb ~375px): mentions wrap naturally within the prose column — inline,
// no horizontal overflow, the underline continues across a line break.
export const Narrow: Story = {
  render: () => (
    <div className="w-[375px] max-w-full text-ink">
      <p className={TYPE_ROLE_CLASS['prose-body']}>
        <EntityMention text="Elenya" glyph="npc" label="entity: Elenya" /> led the way down toward{' '}
        <EntityMention text="Highreach" glyph="location" label="entity: Highreach" />, wary of the{' '}
        <EntityMention text="The Ashen Hand" glyph="faction" label="entity: The Ashen Hand" /> at
        every turn.
      </p>
    </div>
  ),
}
