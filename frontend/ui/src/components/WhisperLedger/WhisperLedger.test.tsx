import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { WhisperLedger } from './WhisperLedger.tsx'

// WhisperLedger — the shared long-wait whisper column (ux-run2 myth-i2pdo): the
// current flavor line over a faint ledger of previously shown lines, newest
// first, fading with age. Purely presentational (the consumer owns the cycle);
// wholly decorative (aria-hidden). These tests pin the stacking order, the age
// fade, the two size registers, and the decorative hiding.

const HISTORY = ['The first grave is marked.', 'Waters spring forth.', 'A gift is given.']

describe('WhisperLedger', () => {
  it('renders the current line over the settled history, newest first', () => {
    const { getByTestId, getAllByTestId } = render(
      <WhisperLedger current="Ink is put to page." history={HISTORY} />,
    )
    expect(getByTestId('whisper-ledger-current').textContent).toBe('Ink is put to page.')
    expect(getAllByTestId('whisper-ledger-line').map((l) => l.textContent)).toEqual(HISTORY)
  })

  it('cues age by MARK SIZE, not opacity — the oldest mark smallest', () => {
    // The cue used to be an opacity ramp on the whole line. That was the age
    // fade and simultaneously a WCAG AA failure: composited on the paper
    // ground, ink-tertiary reaches only 3.49:1 at .80 and 1.39:1 at .25
    // against a 4.5:1 floor, and no ink token in the system can carry a ramp
    // that deep. Age moved onto the decorative mark, which is aria-hidden and
    // therefore has no contrast floor to clear.
    const { getAllByTestId } = render(<WhisperLedger current="Now." history={HISTORY} />)
    const [newest, mid, oldest] = getAllByTestId('whisper-ledger-mark')
    expect(newest?.className).toMatch(/size-\[5px\]/)
    expect(mid?.className).toMatch(/size-\[4px\]/)
    expect(oldest?.className).toMatch(/size-\[3px\]/)
  })

  it('holds every ledger line at ONE passing ink — no opacity anywhere on the line', () => {
    // The regression guard for the fix above: if a future change reintroduces a
    // per-line opacity ramp, the axe colour-contrast check in the story only
    // catches it in the CI-only Playwright sweep. This catches it here.
    const { getAllByTestId } = render(<WhisperLedger current="Now." history={HISTORY} />)
    for (const line of getAllByTestId('whisper-ledger-line')) {
      expect(line.className).not.toMatch(/opacity-/)
      expect(line.className).toMatch(/text-ink-tertiary/)
    }
  })

  it('renders no ledger list at all before anything has settled (reduced motion / fresh mount)', () => {
    const { queryByTestId } = render(<WhisperLedger current="Now." history={[]} />)
    expect(queryByTestId('whisper-ledger-history')).toBeNull()
  })

  it('reserves the ledger WELL from first paint — a fixed-height slot the list grows into (ux-run3 myth-5ekb5)', () => {
    // Run 3: the mark drifted upward ~15px as lines settled beneath it. The
    // ledger now grows DOWNWARD inside a well whose height is reserved at t=0,
    // so settling a line never re-centers the column; overflow (wrapped lines)
    // clips at the bottom where the oldest, most-faded line lives.
    const empty = render(<WhisperLedger current="Now." history={[]} />)
    const well = empty.getByTestId('whisper-ledger-well')
    expect(well.className).toMatch(/h-\[/)
    expect(well.className).toMatch(/overflow-hidden/)
    empty.unmount()
    // The well is THE SAME element once lines settle (list inside it).
    const grown = render(<WhisperLedger current="Now." history={HISTORY} />)
    expect(grown.getByTestId('whisper-ledger-well')).toContainElement(
      grown.getByTestId('whisper-ledger-history'),
    )
  })

  it('marks settled lines with a quiet filled square — none on the live line (ux-run3 myth-1yxfr)', () => {
    // The 1-bit completion mark (square, per register — never a dot or check):
    // each settled whisper is a done line, flipping the log from decoration to
    // progress without touching the prose. The live line carries no mark.
    const { getAllByTestId, getByTestId } = render(
      <WhisperLedger current="Ink is put to page." history={HISTORY} />,
    )
    const marks = getAllByTestId('whisper-ledger-mark')
    expect(marks).toHaveLength(HISTORY.length)
    for (const mark of marks) {
      expect(mark.className).toMatch(/bg-current/)
      expect(mark.className).not.toMatch(/rounded-(?!none)/)
    }
    expect(getByTestId('whisper-ledger-current').querySelector('[data-testid="whisper-ledger-mark"]')).toBeNull()
  })

  it('is wholly decorative — aria-hidden at the root (the surface owns busy semantics)', () => {
    const { getByTestId } = render(
      <WhisperLedger data-testid="ledger" current="Now." history={HISTORY} />,
    )
    expect(getByTestId('ledger')).toHaveAttribute('aria-hidden', 'true')
  })

  it('hero size gives the current line the headline job (~20px); sub keeps it body-quiet', () => {
    const hero = render(<WhisperLedger current="Now." history={[]} />)
    expect(hero.getByTestId('whisper-ledger-current').className).toMatch(/text-xl/)
    hero.unmount()
    const sub = render(<WhisperLedger size="sub" current="Now." history={[]} />)
    expect(sub.getByTestId('whisper-ledger-current').className).toMatch(/text-sm/)
  })
})
