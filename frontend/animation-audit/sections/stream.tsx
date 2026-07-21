import { useEffect, useState } from 'react'
import { Spinner, Stack, StreamingProse, Text, ThinkingIndicator } from '@mythrun/ui'
import type { AuditSection } from '../types.ts'

// ── StreamingProse: prose that ARRIVES. Chunks land on a ~60ms timer (the story's
//    ArrivingDemo pacing); a small ember caret pulses after the last character while
//    writing. Self-restarts so the arrival replays. Reduced motion: caret holds steady.
const BRIEF =
  'A rain-soaked archipelago where the lighthouses are sentient and remember every ' +
  'shipwreck they have witnessed. The keepers trade in recollection: a lamp relit ' +
  'costs a memory the sea has not already taken.'

function ArrivingLoop(): React.JSX.Element {
  const [length, setLength] = useState(0)
  useEffect(() => {
    if (length >= BRIEF.length) {
      const t = window.setTimeout(() => {
        setLength(0)
      }, 2600)
      return () => {
        window.clearTimeout(t)
      }
    }
    const t = window.setTimeout(() => {
      setLength((n) => Math.min(BRIEF.length, n + 3 + Math.floor(Math.random() * 9)))
    }, 60)
    return () => {
      window.clearTimeout(t)
    }
  }, [length])
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <Stack gap={3}>
        <Text role="ui-label">the world we found</Text>
        <StreamingProse text={BRIEF.slice(0, length)} writing={length < BRIEF.length} writingLabel="Still writing" />
      </Stack>
    </div>
  )
}

// ── ThinkingIndicator: the quiet liveness line. The DM-thinking line's square ember
//    mark pulses on the sanctioned opacity fade (CSS; frozen under the gallery's
//    reduced-motion class). Shown with the DM thinking AND two players typing.
function ThinkingDemo(): React.JSX.Element {
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <ThinkingIndicator
        thinking
        typingNames={['Kessa', 'Bram']}
        thinkingLabel="[ph: DM is thinking…]"
        typingLabel="[ph: is typing]"
      />
    </div>
  )
}

// ── Spinner: the brand's signature diagonal dither-wave loader (no rotation — a 12×12
//    binary grid with the lit dither flowing up the diagonal, two notched corners).
//    Reduced motion (internal matchMedia, handled by the shim): a legible static ~40%
//    dither, never blank.
function SpinnerDemo(): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-5)] bg-bg text-ink">
      <div className="flex items-center gap-[var(--space-5)]">
        <Spinner size="xs" />
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
      </div>
      <Spinner size="lg" label="The DM is thinking" />
    </div>
  )
}

export const streamSections: AuditSection[] = [
  {
    id: 'streaming-prose',
    name: 'StreamingProse — prose arriving',
    path: 'frontend/ui/src/components/StreamingProse',
    where: 'Guided create flow (world brief writing itself) and streamed narration',
    note: 'Real deltas append into one stable element; an ember caret pulses after the last character while writing. Self-restarts on a loop. Reduced motion: the caret holds steady (the arriving text is the progress signal).',
    height: 220,
    render: ({ replayKey }) => (
      <div className="h-full w-full overflow-y-auto" style={{ height: 220 }}>
        <ArrivingLoop key={replayKey} />
      </div>
    ),
  },
  {
    id: 'thinking-indicator',
    name: 'ThinkingIndicator — DM thinking',
    path: 'frontend/ui/src/components/ThinkingIndicator',
    where: 'Under the live-play transcript while a DM turn is open',
    note: 'The DS Spinner (xs, accent) sits in-line beside “DM is thinking…” — the same 12×12 hard-binary dither wave as every other loader, optically centered on the text line; typing presence lines unchanged. Reduced motion: the Spinner’s static ~40% dither.',
    height: 140,
    render: ({ replayKey }) => (
      <div className="h-full w-full bg-bg" style={{ height: 140 }}>
        <ThinkingDemo key={replayKey} />
      </div>
    ),
  },
  {
    id: 'spinner',
    name: 'Spinner — dither-wave loader',
    path: 'frontend/ui/src/components/Spinner',
    where: 'Loading buttons, thinking panels, and async control states across the app',
    note: 'The signature diagonal dither wave (no rotation): lit cells flow up the diagonal on a ~1.8s loop, two notched corners. Reduced motion (internal matchMedia, gallery shim): settles to a legible static ~40% dither.',
    height: 200,
    render: ({ replayKey }) => (
      <div className="h-full w-full" style={{ height: 200 }}>
        <SpinnerDemo key={replayKey} />
      </div>
    ),
  },
]
