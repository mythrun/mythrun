import type { GraphNode } from '@mythrun/client-core/contract'
import type { GraphLegendLabels } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// GraphLegend (myth-466cy) — the graph's glyph KEY. The graph encodes an entity's
// kind in the SHAPE of its ink glyph (diamond = faction, square = location, a
// stacked pair = a person, a small square = item), and with nothing telling the
// reader that, "a relationship graph whose symbol system is undocumented is
// decoration, not information" (the run-1 critique) — and the un-named glyphs read
// as a rendering glitch. This is the quiet key that turns the vocabulary legible.
//
// A DERIVED key, not a fixed list: it renders one entry per kind ACTUALLY present
// in `nodes` (in a stable vocabulary order), each only if the consumer supplied a
// resolved label for it — so it never documents a glyph the world doesn't contain,
// and the DS invents no copy (the labels are the same i18n map the wiki's
// group headings speak). A world with no labelled kinds renders nothing.
//
// Flat 1-bit paper / SQUARE register: the swatches are the SAME hard-edged shapes
// the Canvas draws (drawGlyph), in `currentColor` at the full ink so the key reads
// as the graph's own ink; the labels sit a step quieter (--ink-secondary). No
// chips, no circles, no bullets — a spaced row of shape·word pairs.

/** The glyph vocabulary order — most-common kinds first (ux-run2 myth-asd9d: a
 *  real gen is ~22 places / ~15 people / ~9 factions, so the key leads with what
 *  the eye meets most, not the rarest type); the anchor kinds (pc/world) last
 *  when a world carries them. Only kinds present in `nodes` AND carrying a label
 *  render. */
const KIND_ORDER: readonly string[] = ['location', 'npc', 'faction', 'item', 'pc', 'world']

/** Each kind's swatch, a 14×14 hard-edged shape mirroring `drawGlyph`. `fill`/`stroke`
 *  are `currentColor` so the swatch inherits the ink the row sets — strictly two-tone
 *  paper+ink, no new colour (no-ad-hoc-color safe). */
function KindSwatch({ kind }: { kind: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className="h-[0.9em] w-[0.9em] shrink-0 text-ink"
      fill="currentColor"
      stroke="currentColor"
    >
      {kind === 'faction' && <path d="M7 1 L13 7 L7 13 L1 7 Z" />}
      {kind === 'location' && <rect x="2" y="2" width="10" height="10" />}
      {kind === 'item' && <rect x="4" y="4" width="6" height="6" />}
      {/* People stacks carry DAYLIGHT between head and body (ux-run2 myth-asd9d):
          fused, the pair read as one square — indistinguishable from Places at
          legend size. The gap is what makes the figure silhouette legible. */}
      {kind === 'npc' && (
        <>
          <rect x="4.2" y="0.8" width="5.6" height="4.7" />
          <rect x="1.5" y="7" width="11" height="5.5" />
        </>
      )}
      {kind === 'pc' && (
        <>
          <rect x="0.75" y="0.75" width="12.5" height="12.5" fill="none" strokeWidth="1" />
          <rect x="4.5" y="2.6" width="5" height="3.9" />
          <rect x="2.5" y="7.5" width="9" height="4.5" />
        </>
      )}
      {kind === 'world' && (
        <>
          <rect x="1.5" y="1.5" width="11" height="11" fill="none" strokeWidth="1.2" />
          <rect x="4.75" y="4.75" width="4.5" height="4.5" fill="none" strokeWidth="1.2" />
        </>
      )}
    </svg>
  )
}

export interface GraphLegendProps {
  /** The current node set — the key documents only the kinds it actually contains. */
  nodes: readonly GraphNode[]
  /** Resolved kind → label copy (the DS owns none). A kind without a label is omitted. */
  labels: GraphLegendLabels
  'data-testid'?: string
}

/** The graph's glyph key — a quiet spaced row of shape·word pairs for every entity
 *  kind present in `nodes` that carries a label. */
export function GraphLegend({ nodes, labels, 'data-testid': dataTestId }: GraphLegendProps): React.JSX.Element | null {
  const present = new Set(nodes.map((n) => n.kind))
  const entries = KIND_ORDER.filter((kind) => present.has(kind) && (labels[kind] ?? '').length > 0)
  if (entries.length === 0) return null
  return (
    <ul
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'flex min-w-0 list-none flex-wrap items-center',
        'gap-x-[var(--space-4)] gap-y-[var(--space-1)]',
        'px-[var(--space-2)] font-ui text-xs text-ink-secondary',
      )}
    >
      {entries.map((kind) => (
        <li key={kind} className="flex items-center gap-[var(--space-1)]">
          <KindSwatch kind={kind} />
          <span>{labels[kind]}</span>
        </li>
      ))}
    </ul>
  )
}
