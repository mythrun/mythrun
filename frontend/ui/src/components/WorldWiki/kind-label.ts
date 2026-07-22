import type { EntityKind } from '@mythrun/contract/rest'
import type { WorldWikiProps } from '@mythrun/client-core/contract'

// The wiki's ONE kind-copy mechanism: every surface that speaks a kind — the
// home's group headings, a page's kind tag — resolves through the same
// consumer `groupLabels` map. One map, two surfaces: they can never drift apart.
// A kind absent from the map resolves to an empty label — the DS owns no copy, so
// it invents no placeholder; the app supplies the full map from i18n.

/** Resolve a kind's display copy from the consumer map, else '' (the DS invents
 *  no copy — a full map is the app's responsibility). */
export function resolveKindLabel(
  kind: EntityKind,
  groupLabels: WorldWikiProps['groupLabels'],
): string {
  return groupLabels?.[kind] ?? ''
}
