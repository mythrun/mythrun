import { useEffect, useState } from 'react'
import { Text, WorldWiki } from '@mythrun/ui'
import {
  useApiContext,
  type ApiContext,
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { toWikiViewModel, type WikiViewModel, type WikiNavigation } from '@mythrun/client-core/worldgen'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

// The WORLD-WIKI PANEL — the snapshot fetch/refetch model + the panel that renders
// it. Born in the world reveal (MYT-89 Phase D, extracted at the D6 module-size
// ceiling as worldgen/reveal-wiki-panel.tsx); PROMOTED here in MYT-102 because the
// character-create screen mounts the same browsable wiki beside the concept
// prompts (grounding: the player writes against a world they can actually
// consult). Behavior-preserving — the reveal composes it exactly as it did, via a
// re-export shim at worldgen/reveal-wiki-panel.tsx.

/** Fetches the FULL known-tier snapshot. Typed as the RELATIONSHIP-BEARING
 *  `WorldGenSnapshot` (`getWorldSnapshot`'s actual response — assignable to the
 *  view model's `WikiSnapshot`): a relationship-less source is a COMPILE error,
 *  so the wiki's RELATED cross-links can never silently come up empty (the
 *  D2-review re-type). Injected so tests substitute a resolved fixture. The
 *  reveal mounts this screen only after the boundary stage
 *  (entity_relationships) has committed — the same stage the endpoint's 409
 *  gate checks — so the fetch never 409s; character creation mounts strictly
 *  later (a complete world). The known-tier filter is SERVER-side
 *  (worldSnapshotView, enforced ignorance): fetching mid-tail serves the same
 *  known-only projection as post-completion. */
export type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>

export interface WikiModelState {
  readonly model: WikiViewModel | null
  readonly loading: boolean
  /** The last (re)fetch REJECTED. Only rendered when no model has ever
   *  resolved: the panel shows the honest UNAVAILABLE line (transient
   *  failures and true denials — a non-member — look the same from here),
   *  never an error flash. Members read the snapshot since myth-0xwos. */
  readonly failed: boolean
}

/** Fetch the world snapshot and normalize it to the wiki view model; REFETCH
 *  quietly whenever `refreshToken` bumps (a silent tail stage completed — the
 *  reconciled world). Quiet by construction: `loading` is only ever true before
 *  the FIRST settle, and the current model stays rendered until a fresh one
 *  resolves (a refetch failure keeps the old model — the next tail completion
 *  retries). A failed first fetch settles to the calm unavailable line (never
 *  throws into the route). The `active` flag drops a late resolve after
 *  unmount / a superseded refetch. */
export function useWikiModel(
  campaignId: string,
  fetchSnapshot: FetchSnapshot,
  refreshToken: number,
): WikiModelState {
  const ctx = useApiContext()
  const [state, setState] = useState<WikiModelState>({ model: null, loading: true, failed: false })
  useEffect(() => {
    let active = true
    void fetchSnapshot(ctx, campaignId)
      .then((snapshot) => {
        if (!active) return
        setState({ model: toWikiViewModel(snapshot), loading: false, failed: false })
      })
      .catch(() => {
        if (active) setState((s) => ({ ...s, loading: false, failed: true }))
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, fetchSnapshot, refreshToken])
  return state
}

/** The calm single-line states of the wiki panel before a model exists:
 *  loading → the settling line; a failed fetch → the honest unavailable line;
 *  the (defensive) remainder → the empty line. */
function panelLine(state: WikiModelState, t: TFunction): string {
  if (state.loading) return t('worldReveal.loading')
  return state.failed ? t('worldReveal.unavailable') : t('worldReveal.empty')
}

interface WikiPanelProps {
  state: WikiModelState
  /** The one-shot external push signal (a graph tap) — NOT the persistent
   *  selection; see the one-shot effect in `WorldReveal`. */
  externalSelection: string | undefined
  onSelect: (entityId: string) => void
  query: string
  onQuery: (query: string) => void
  /** The active creation step's topic (ux-run2 myth-ehcf4), forwarded to the
   *  step-aware panel — see `WorldWikiProps.stepContext` for the contract. The
   *  guided builder passes its step topic / selected card name; every other
   *  host omits it. */
  stepContext?: string
  /** A LIFTED wiki page stack, forwarded verbatim — see
   *  `WorldWikiProps.navigation`. The mobile reveal supplies one so hardware
   *  Back can pop a page before closing the drawer (myth-g7kg6); every other
   *  host omits it and the wiki keeps its own. */
  navigation?: WikiNavigation
}

/** The wiki side of a world surface: a calm i18n line while the snapshot
 *  loads (or failed to), else the browsable `WorldWiki` with every chrome label
 *  resolved from the app catalog (the DS owns no copy). */
export function WikiPanel({ state, externalSelection, onSelect, query, onQuery, stepContext, navigation }: WikiPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  if (state.model === null) {
    return (
      <Text role="ui-caption" as="p">
        {panelLine(state, t)}
      </Text>
    )
  }
  return (
    <WorldWiki
      data-testid="reveal-wiki"
      model={state.model}
      onSelect={onSelect}
      query={query}
      onQuery={onQuery}
      searchLabel={t('worldReveal.wikiSearchLabel')}
      searchPlaceholder={t('worldReveal.wikiSearchPlaceholder')}
      emptyLabel={t('worldReveal.wikiEmpty')}
      backLabel={t('worldReveal.wikiBack')}
      relatedLabel={t('worldReveal.wikiRelated')}
      emptyBodyLabel={t('worldReveal.wikiEmptyBody')}
      referencesLabel={t('worldReveal.wikiDigDeeper')}
      indexLabel={t('worldReveal.wikiIndex')}
      glossaryLabel={t('worldReveal.wikiGlossary')}
      groupLabels={{
        faction: t('worldReveal.group.faction'),
        location: t('worldReveal.group.location'),
        npc: t('worldReveal.group.npc'),
        item: t('worldReveal.group.item'),
      }}
      {...(externalSelection !== undefined ? { selectedId: externalSelection } : {})}
      {...(stepContext !== undefined ? { stepContext } : {})}
      {...(navigation !== undefined ? { navigation } : {})}
    />
  )
}
