import type { EntityKind } from '@mythrun/contract/rest'
import type { WorldWikiProps } from '@mythrun/client-core/contract'

// The wiki's ONE kind-copy mechanism: every surface that speaks a kind — the
// home's group headings, a page's kind tag — resolves through the same
// consumer `groupLabels` map, falling back to a `[ph: <kind>]` placeholder.
// One map, two surfaces: they can never drift apart when the app wires real
// i18n keys.

/** Resolve a kind's display copy from the consumer map, else a `[ph: …]` default. */
export function resolveKindLabel(
  kind: EntityKind,
  groupLabels: WorldWikiProps['groupLabels'],
): string {
  return groupLabels?.[kind] ?? `[ph: ${kind}]`
}
