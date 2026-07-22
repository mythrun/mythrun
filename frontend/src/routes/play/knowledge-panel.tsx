import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  type ConnectionStatus,
  type KnowledgeCache,
  type LedgerUpdateFrame,
  type SessionSheetState,
} from '@mythrun/client-core'
import type {
  EntityGlyph,
  EntityIndex,
  KnowledgeSidebarProps,
  KnowledgeTab,
  MessageStreamProps,
  TranscriptItem,
} from '@mythrun/client-core/contract'
import { Box, Drawer, Heading, IconButton, KnowledgeSidebar, Stack, useViewportBelowLg } from '@mythrun/ui'

// The play-screen knowledge layer (MYT-94, spec §6 / UX §9) — the brain + the
// composition shell that fills MYT-92's `SidebarPlaceholder` seam.
//
// `usePlayKnowledge` is the ROUTE BRAIN: it owns the one-snapshot knowledge cache
// (wiki + graph + the highlighting index), the in-session sheet view-model, and the
// shared sidebar state (active tab / selection / wiki query / open) that BOTH the
// chat highlighting (MessageStream, in the shell) and the sidebar read from. It
// lives here (not in the shell body) so `SessionShell` stays a thin composition and
// its function stays under the size ceiling; the two data hooks are INJECTED
// (`hooks`) so the shell supplies the real client-core hooks in production and tests
// substitute fakes — the same seam `useSession` rides through `useLiveSession`.
//
// `KnowledgePanel` is the PRESENTATION shell around the shipped `KnowledgeSidebar`:
// desktop → a collapsible ~30% rail (default OPEN, UX §9); narrow → the shipped
// edge-handle `Drawer` (mount-persistent — tab/nav state survives close→open). The
// rail↔drawer flip is a SINGLE structural mount driven by the DS's `lg`-step JS
// regime (`useViewportBelowLg`, the reveal's D5 idiom), NOT a pair of CSS `Show`s —
// two mounts would run two `WorldGenGraph` canvases and collide the sidebar testids,
// AND a `Show`'s `display:none` can't hide the Drawer's PORTALED content anyway.
//
// Enforced ignorance holds by construction: every read is the member-readable
// snapshot / character projection the injected hooks already fetch; this layer adds
// no read surface and no client-side tier logic.

/** The desktop side-panel width — the sanctioned layout escape hatch (a fixed
 *  side-panel basis is not expressible via @mythrun/ui Box props). ~30% at common
 *  desktop widths; MYT-92's seam used `w-[18rem]`, widened here for the three tabs. */
const RAIL_WIDTH_CLASS = 'w-[22rem]'

// The stable seam/toggle testids MYT-92's shell tests key on — preserved so the
// placeholder's meaning migrates into the real panel.
const SEAM_TESTID = 'session-sidebar-seam'
const TOGGLE_TESTID = 'session-sidebar-toggle'

/** `EntityGlyph` → its i18n type-label key (the monochrome glyph's accessible name;
 *  no colour). Literal keys so the typed-i18n augmentation accepts them. */
const TYPE_LABEL_KEY = {
  npc: 'play.knowledge.type.npc',
  location: 'play.knowledge.type.location',
  faction: 'play.knowledge.type.faction',
  other: 'play.knowledge.type.other',
} as const satisfies Record<EntityGlyph, string>

/** The two client-core data hooks the brain composes — injected so the shell wires
 *  the real hooks (production) and tests substitute fakes (no transport). */
export interface PlayKnowledgeHooks {
  readonly useCache: (campaignId: string, refreshToken: number) => KnowledgeCache
  readonly useSheet: (
    campaignId: string,
    viewerUserId: string,
    viewerCharacterName: string,
    ledgerFrames: readonly LedgerUpdateFrame[],
  ) => SessionSheetState
}

export interface UsePlayKnowledgeArgs {
  readonly campaignId: string
  readonly viewerUserId: string
  readonly viewerCharacterName: string
  /** The live transcript — the source of the `ledger_update` frames folded into the
   *  sheet overlay. */
  readonly items: readonly TranscriptItem[]
  /** The transport status — a `reconnecting → connected` transition is a session
   *  boundary that bumps the cache refetch (the safe-default promotion path). */
  readonly connectionStatus: ConnectionStatus
  readonly hooks: PlayKnowledgeHooks
}

/** The resolved knowledge state the shell threads into the chat (highlighting) and
 *  the sidebar. */
export interface PlayKnowledge {
  readonly cache: KnowledgeCache
  readonly sheet: SessionSheetState
  readonly activeTab: KnowledgeTab
  readonly selectedEntityId: string | undefined
  readonly wikiQuery: string
  readonly railOpen: boolean
  readonly drawerOpen: boolean
  /** The compiled matcher for chat highlighting — `undefined` until the cache
   *  settles (so the shell passes `highlight` only when the index is non-null). */
  readonly highlight: EntityIndex | undefined
  readonly onTabChange: (tab: KnowledgeTab) => void
  readonly onSelectEntity: (entityId: string) => void
  readonly onWikiQuery: (query: string) => void
  /** Toggle the desktop rail between the ~30% panel and the collapsed handle. */
  readonly onToggleRail: () => void
  readonly onDrawerOpenChange: (open: boolean) => void
  /** A chat entity-highlight click → select the entity, force the wiki tab, and
   *  open the sidebar (desktop rail if collapsed / the mobile drawer) — UX §9. */
  readonly onEntityOpen: (entityId: string) => void
}

/** Extract the viewer-agnostic `ledger_update` frames from the transcript; the sheet
 *  hook filters them to the viewer's own character. */
function extractLedgerFrames(items: readonly TranscriptItem[]): readonly LedgerUpdateFrame[] {
  return items.flatMap((item) => (item.kind === 'ledger_update' ? [item.frame] : []))
}

/**
 * The play-screen knowledge brain — cache + sheet + the shared sidebar state.
 */
export function usePlayKnowledge({
  campaignId,
  viewerUserId,
  viewerCharacterName,
  items,
  connectionStatus,
  hooks,
}: UsePlayKnowledgeArgs): PlayKnowledge {
  const refreshToken = useReconnectRefreshToken(connectionStatus)
  const cache = hooks.useCache(campaignId, refreshToken)

  // The ledger overlay keys on the character NAME, which the route only learns once
  // the sheet read lands (the roster carries no name — see the T6 report). Feed the
  // resolved name back so the live overlay folds even though play-session passes an
  // empty `viewerCharacterName` today; the sheet fetch does not depend on the name,
  // so this never re-fetches.
  const ledgerFrames = useMemo(() => extractLedgerFrames(items), [items])
  const [resolvedName, setResolvedName] = useState(viewerCharacterName)
  const sheet = hooks.useSheet(campaignId, viewerUserId, resolvedName, ledgerFrames)
  const sheetName = sheet.sheet?.name
  useEffect(() => {
    if (sheetName !== undefined && sheetName !== resolvedName) setResolvedName(sheetName)
  }, [sheetName, resolvedName])

  const [activeTab, setActiveTab] = useState<KnowledgeTab>('wiki')
  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined)
  const [wikiQuery, setWikiQuery] = useState('')
  const [railOpen, setRailOpen] = useState(true) // desktop default OPEN (UX §9)
  const [drawerOpen, setDrawerOpen] = useState(false) // narrow default closed (chat owns the glass)

  const onToggleRail = useCallback(() => {
    setRailOpen((open) => !open)
  }, [])
  const onEntityOpen = useCallback((entityId: string) => {
    setSelectedEntityId(entityId)
    setActiveTab('wiki')
    setRailOpen(true)
    setDrawerOpen(true)
  }, [])

  return {
    cache,
    sheet,
    activeTab,
    selectedEntityId,
    wikiQuery,
    railOpen,
    drawerOpen,
    highlight: cache.index ?? undefined,
    onTabChange: setActiveTab,
    onSelectEntity: setSelectedEntityId,
    onWikiQuery: setWikiQuery,
    onToggleRail,
    onDrawerOpenChange: setDrawerOpen,
    onEntityOpen,
  }
}

/** A boundary-only cache refetch token: bumped when the transport transitions
 *  `reconnecting → connected` (a `session_reconnect` — the safe-default promotion
 *  path, spec §6). The mount fetch is the cache hook's own concern (token 0). */
function useReconnectRefreshToken(connectionStatus: ConnectionStatus): number {
  const [token, setToken] = useState(0)
  const prevStatus = useRef(connectionStatus)
  useEffect(() => {
    const prev = prevStatus.current
    prevStatus.current = connectionStatus
    if (prev === 'reconnecting' && connectionStatus === 'connected') {
      setToken((n) => n + 1)
    }
  }, [connectionStatus])
  return token
}

/** Build the resolved mention/popover chrome the shell threads into MessageStream.
 *  The entity NAME is DATA (from the model), interpolated into the accessible name. */
export function buildHighlightLabels(t: TFunction): NonNullable<MessageStreamProps['highlightLabels']> {
  return {
    mentionLabelFor: (name) => t('play.knowledge.mention', { name }),
    typeLabelFor: (glyph) => t(TYPE_LABEL_KEY[glyph]),
    openInWikiLabel: t('play.knowledge.openInWiki'),
  }
}

/** The KnowledgeSidebar chrome-label subset the route resolves from i18n. */
type SidebarLabels = Pick<
  KnowledgeSidebarProps,
  | 'tabsLabel'
  | 'wikiTabLabel'
  | 'graphTabLabel'
  | 'sheetTabLabel'
  | 'graphNodeListLabel'
  | 'wikiUnavailableLabel'
  | 'graphUnavailableLabel'
  | 'sheetUnavailableLabel'
  | 'wikiLabels'
  | 'sheetLabels'
>

/** Resolve every KnowledgeSidebar chrome label from the catalog (the DS owns no
 *  copy). Entity names, facts, and prose are DATA (from the model), never keys. */
function buildSidebarLabels(t: TFunction): SidebarLabels {
  return {
    tabsLabel: t('play.knowledge.tabs'),
    wikiTabLabel: t('play.knowledge.wikiTab'),
    graphTabLabel: t('play.knowledge.graphTab'),
    sheetTabLabel: t('play.knowledge.sheetTab'),
    graphNodeListLabel: t('play.knowledge.graphNodes'),
    wikiUnavailableLabel: t('play.knowledge.wikiUnavailable'),
    graphUnavailableLabel: t('play.knowledge.graphUnavailable'),
    sheetUnavailableLabel: t('play.knowledge.sheetUnavailable'),
    wikiLabels: {
      searchLabel: t('play.knowledge.wiki.search'),
      searchPlaceholder: t('play.knowledge.wiki.searchPlaceholder'),
      emptyLabel: t('play.knowledge.wiki.empty'),
      backLabel: t('play.knowledge.wiki.back'),
      relatedLabel: t('play.knowledge.wiki.related'),
      emptyBodyLabel: t('play.knowledge.wiki.emptyBody'),
      referencesLabel: t('play.knowledge.wiki.references'),
      indexLabel: t('play.knowledge.wiki.index'),
      glossaryLabel: t('play.knowledge.wiki.glossary'),
      groupLabels: {
        faction: t('play.knowledge.wiki.group.faction'),
        location: t('play.knowledge.wiki.group.location'),
        npc: t('play.knowledge.wiki.group.npc'),
        item: t('play.knowledge.wiki.group.item'),
      },
    },
    sheetLabels: {
      hpLabel: t('play.knowledge.sheet.hp'),
      conditionsLabel: t('play.knowledge.sheet.conditions'),
      emptyLabel: t('play.knowledge.sheet.empty'),
    },
  }
}

export interface KnowledgePanelProps {
  readonly knowledge: PlayKnowledge
  readonly reducedMotion: boolean
}

/**
 * The composition shell around `KnowledgeSidebar`: the desktop collapsible rail OR
 * the narrow edge-handle drawer (one structural mount, chosen by viewport).
 */
export function KnowledgePanel({ knowledge, reducedMotion }: KnowledgePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const belowLg = useViewportBelowLg()
  const sidebar = (
    <KnowledgeSidebar
      cache={knowledge.cache}
      sheet={knowledge.sheet}
      activeTab={knowledge.activeTab}
      onTabChange={knowledge.onTabChange}
      onSelectEntity={knowledge.onSelectEntity}
      wikiQuery={knowledge.wikiQuery}
      onWikiQuery={knowledge.onWikiQuery}
      reducedMotion={reducedMotion}
      {...buildSidebarLabels(t)}
      {...(knowledge.selectedEntityId !== undefined ? { selectedEntityId: knowledge.selectedEntityId } : {})}
    />
  )
  return belowLg ? (
    <Drawer
      data-testid={SEAM_TESTID}
      title={t('play.sidebar.title')}
      openLabel={t('play.sidebar.expand')}
      closeLabel={t('play.sidebar.collapse')}
      open={knowledge.drawerOpen}
      onOpenChange={knowledge.onDrawerOpenChange}
    >
      {sidebar}
    </Drawer>
  ) : (
    <DesktopRail open={knowledge.railOpen} onToggle={knowledge.onToggleRail} t={t}>
      {sidebar}
    </DesktopRail>
  )
}

/** The desktop rail: the ~30% panel (default OPEN) with a collapse toggle, or the
 *  slim collapsed handle. The scroll region owns the overflow so the tall sheet tab
 *  scrolls inside the rail, not the page. */
function DesktopRail({
  open,
  onToggle,
  t,
  children,
}: {
  open: boolean
  onToggle: () => void
  t: TFunction
  children: ReactNode
}): React.JSX.Element {
  if (!open) {
    return (
      <Box border surface="base" padding={2} data-testid={SEAM_TESTID}>
        <IconButton
          icon="chevron-left"
          label={t('play.sidebar.expand')}
          variant="ghost"
          size="sm"
          onPress={onToggle}
          data-testid={TOGGLE_TESTID}
        />
      </Box>
    )
  }
  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- fixed side-panel width + the min-h-0 flex-scroll column; not expressible via @mythrun/ui Box props (BaseProps bans className)
    <div className={`flex min-h-0 flex-col gap-[var(--space-2)] ${RAIL_WIDTH_CLASS}`} data-testid={SEAM_TESTID}>
      <Box border surface="base" padding={3}>
        <Stack direction="row" justify="between" align="center" gap={2}>
          <Heading level={2}>{t('play.sidebar.title')}</Heading>
          <IconButton
            icon="chevron-right"
            label={t('play.sidebar.collapse')}
            variant="ghost"
            size="sm"
            onPress={onToggle}
            data-testid={TOGGLE_TESTID}
          />
        </Stack>
      </Box>
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the rail scroll region; MessageStream-style min-h-0 overflow so the sheet tab scrolls inside the rail, not the page */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-none border border-border-strong bg-surface p-[var(--space-3)]">
        {children}
      </div>
    </div>
  )
}
