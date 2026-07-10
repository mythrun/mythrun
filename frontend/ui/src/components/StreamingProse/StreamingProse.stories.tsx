import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { StreamingProse } from './StreamingProse.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'

// StreamingProse — prose that ARRIVES (myth-umggn). The render surface for LLM
// text streaming in live: the guided create flow's world brief writing itself,
// and later any streamed narration. Renders byte-identical in type classes to
// `<Text role="prose-body" as="p">` (zero-reflow handoff when the stream
// finishes); while `writing`, a small ember caret pulses after the last
// character on the brand's sanctioned opacity fade. Under reduced motion the
// caret holds steady — the arriving text itself is the progress signal.
//
// Do: keep the SAME element mounted from first delta through settle (flip
//   `writing` off at the terminal) so the text never flashes.
// Don't: fake arrival with per-character typewriter timers — feed REAL deltas
//   as the wire delivers them; never add a spinner next to the caret.
// Content/i18n: `text` is streamed DATA (never an i18n key); `writingLabel`
//   is an i18n key the consumer resolves.

const meta: Meta<typeof StreamingProse> = {
  title: 'Typography/StreamingProse',
  component: StreamingProse,
  tags: ['autodocs'],
  argTypes: {
    writing: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof StreamingProse>

const BRIEF =
  'A rain-soaked archipelago where the lighthouses are sentient and remember every ' +
  'shipwreck they have witnessed. The keepers trade in recollection: a lamp relit ' +
  'costs a memory the sea has not already taken.'

export const Writing: Story = {
  name: 'Writing (mid-stream)',
  args: {
    text: BRIEF.slice(0, 96),
    writing: true,
    writingLabel: 'Still writing',
  },
}

export const Settled: Story = {
  name: 'Settled (stream complete)',
  args: { text: BRIEF, writing: false },
}

// A self-driving demo: chunks arrive on a timer to PREVIEW the live feel.
// (Demo-only pacing — production feeds real wire deltas, never fake timers.)
function ArrivingDemo(): React.JSX.Element {
  const [length, setLength] = useState(0)
  useEffect(() => {
    if (length >= BRIEF.length) return
    const t = setTimeout(() => {
      setLength((n) => Math.min(BRIEF.length, n + 3 + Math.floor(Math.random() * 9)))
    }, 60)
    return () => {
      clearTimeout(t)
    }
  }, [length])
  return (
    <Stack gap={3}>
      <Text role="ui-label">the world we found</Text>
      <StreamingProse
        text={BRIEF.slice(0, length)}
        writing={length < BRIEF.length}
        writingLabel="Still writing"
      />
    </Stack>
  )
}

export const Arriving: Story = {
  name: 'Arriving (demo stream)',
  render: () => <ArrivingDemo />,
}
