import type { ReactNode } from 'react'

/** One copy entry — an inventory row merged with its (optional) suggestion set,
 *  plus two synthetic families: a `catalog` meta-entry (its `targetKeys` are the
 *  real keys its lines fan out to) and `ds` entries (strings HARDCODED in the
 *  design system — `hardcoded: true` — not i18n keys, owned only by the store). */
export interface Entry {
  key: string
  flow: string
  current: string
  description: string
  interpolated: boolean
  usedIn: string[]
  kind: 'single' | 'multiline' | 'group' | 'catalog' | 'ds'
  groupId: string | null
  suggestions: string[]
  rationale: string
  flags: string[]
  exampleHint: string
  /** When set, this key is folded into the named catalog card (not rendered alone). */
  subsumedBy: string | null
  /** For a `catalog` entry: the real keys its lines fan out to, in order. */
  targetKeys: string[] | null
  /** True for `ds:*` entries — a design-system constant, not an i18n key. */
  hardcoded: boolean
}

export interface CopyData {
  entries: Record<string, Entry>
  order: string[]
  meta: {
    generatedAt: string
    inventoryTotal: number
    authorable: number
    dsDefaults: number
    hasCatalog: boolean
    suggestionFilesPresent: string[]
    suggestionFilesMissing: string[]
  }
}

/** A designer's decision for one key: chosen copy + a free-form criticism note. */
export interface KeyEntryState {
  value: string
  criticism: string
}

/** A bespoke exhibit: a real @mythrun/ui component (or composed DS layout) mounted
 *  in a representative state, reading its strings live from i18n so overrides
 *  repaint it. Declares the keys it renders so their editor cards can highlight
 *  where each string sits. */
export interface Scene {
  /** Stable id (unique within its flow). */
  id: string
  /** Human title for the exhibit head. */
  title: string
  /** One-line note on what's shown / how it's driven. */
  note: string
  /** 'real' → a real @mythrun/ui component; 'composed' → real DS pieces assembled. */
  kind: 'real' | 'composed'
  /** The keys this scene renders (their editors group under it). */
  keys: string[]
  /** Suggested exhibit height in px (the ground gets this min-height). */
  minHeight?: number
  /** Render the exhibit. Reads i18n internally (via <T> / useTranslation). */
  render: () => ReactNode
}
