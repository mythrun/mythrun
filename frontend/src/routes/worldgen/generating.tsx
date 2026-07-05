import { useState } from 'react'
import { Stack, Text, WorldGenGraph } from '@mythrun/ui'
import type { WorldGenStream } from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'

// The GENERATING VIEW (MYT-89 Phase C, C6) — the live world-gen experience the
// `/campaigns/:id` route lands on after Begin, and the returnable background
// state a player can leave and re-enter (C5's rehydration handles re-entry).
//
// It composes C4's `WorldGenGraph` (the decorative Canvas + accessible entity
// list) fed the `nodes`/`edges` C5's `useWorldGenStream` folds off the SSE
// stream, plus one quiet phase line. Deliberately NO progress bar: the graph
// growing IS the progress (spec §7). Flat 1-bit paper register — no chrome.

/** Just the folded graph model — the route owns the stream; this view is a pure
 *  presentational surface over its `nodes`/`edges`, so it stays trivially testable. */
type GeneratingViewProps = Pick<WorldGenStream, 'nodes' | 'edges'>

export function GeneratingView({ nodes, edges }: GeneratingViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // Selection is a local, ephemeral concern (which entity the player is peeking
  // at) — it never leaves this screen, so it lives here, not in the stream.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined)

  return (
    <Stack gap={4} data-testid="worldgen-generating">
      {/* `selectedKey` is spread conditionally — under exactOptionalPropertyTypes
          the optional prop rejects an explicit `undefined`. */}
      <WorldGenGraph
        nodes={nodes}
        edges={edges}
        onSelect={setSelectedKey}
        {...(selectedKey !== undefined ? { selectedKey } : {})}
      />
      <Text role="ui-caption">{t('worldGen.shaping')}</Text>
    </Stack>
  )
}
