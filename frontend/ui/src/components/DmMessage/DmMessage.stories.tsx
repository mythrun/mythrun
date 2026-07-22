import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DmMessage } from './DmMessage.tsx'
import { STORY_INDEX, STORY_LABELS } from './highlight.fixture.ts'

// DmMessage — the DM's narrative register in the live transcript (MYT-92). One row
// of Source Serif 4 prose on a quiet warm paper tint: the feeling of a book being
// read. A thin wrapper over StreamingProse — while `streaming`, an ember caret
// pulses after the last character (the brand's sanctioned opacity fade) and the
// text arrives token-wise into a single stable text node (append-only, zero
// reflow); on settle the caret leaves and the row hands off to static prose with
// no flash. The DM/player split is carried by the serif face AND this tint
// (players are `--font-ui` on their own tint) — never by an avatar or a bubble.
//
// Do: keep the SAME row mounted from first delta through settle (flip `streaming`
//   off at `turn_end`) so the prose never flashes.
// Don't: fake arrival with per-character typewriter timers — feed REAL wire
//   deltas; never add a spinner beside the caret.
// Content/i18n: `text` is streamed DATA (never an i18n key); `writingLabel` is a
//   resolved i18n key the consumer passes.

const meta: Meta<typeof DmMessage> = {
  title: 'Session/DmMessage',
  component: DmMessage,
  tags: ['autodocs'],
  argTypes: {
    streaming: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof DmMessage>

const NARRATION =
  'The tavern door groans against the wind, and for a moment the whole room turns to ' +
  'look at you — the card players, the old woman by the hearth, the barkeep with his ' +
  'rag gone still in his hand. Then the noise folds back over the silence, and you are ' +
  'just another traveller shaking the rain from your coat.'

export const Streaming: Story = {
  name: 'Streaming (mid-turn)',
  args: {
    text: NARRATION.slice(0, 118),
    streaming: true,
    writingLabel: 'The DM is writing',
  },
}

export const Settled: Story = {
  name: 'Settled (turn complete)',
  args: { text: NARRATION, streaming: false },
}

// A self-driving demo: chunks arrive on a timer to PREVIEW the live feel.
// (Demo-only pacing — production feeds real wire deltas, never fake timers.)
function ArrivingDemo(): React.JSX.Element {
  const [length, setLength] = useState(0)
  useEffect(() => {
    if (length >= NARRATION.length) return
    const t = setTimeout(() => {
      setLength((n) => Math.min(NARRATION.length, n + 3 + Math.floor(Math.random() * 9)))
    }, 60)
    return () => {
      clearTimeout(t)
    }
  }, [length])
  return (
    <DmMessage
      text={NARRATION.slice(0, length)}
      streaming={length < NARRATION.length}
      writingLabel="The DM is writing"
    />
  )
}

export const Arriving: Story = {
  name: 'Arriving (demo stream)',
  render: () => <ArrivingDemo />,
}

// MYT-94 — a SETTLED turn with entity highlighting on. Recognized world-lore names
// (Elenya, Highreach, the Ashen Hand) carry a subtle resting underline; hover/focus reveals
// a monochrome type glyph and clicking opens the terse knowledge popover. Highlighting runs
// ONLY on settled prose (the Streaming story shows the byte-identical mid-turn path). The
// index + chrome labels come from a story fixture; in play they come from the client-core
// knowledge cache + the route's i18n.
const HL_NARRATION =
  'You find Elenya on the switchback stairs below Highreach, her satchel heavy with fresh ' +
  'cuttings. She does not look up from her work. "the Ashen Hand came through at first light," ' +
  'she says, quiet as the wind. "They were asking after you by name."'

export const Highlighted: Story = {
  name: 'Highlighted (settled, with mentions)',
  args: {
    text: HL_NARRATION,
    streaming: false,
    highlight: STORY_INDEX,
    highlightLabels: STORY_LABELS,
  },
}
