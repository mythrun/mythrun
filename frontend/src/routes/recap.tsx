import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Stack, Heading, Text, Button, Spinner, Divider } from '@mythrun/ui'
import {
  getMyCampaigns,
  useApiContext,
  useSessionRecap,
  type SessionRecap,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { absoluteUrl, copyText } from '../platform/web/share.ts'

// The post-play session recap (`/campaigns/:id/recap`, myth-lhp99) — where a
// session lands after the DM's farewell + the `session_end` frame. It renders the
// SECRET-FREE post-session analysis (summary + emerging threads) the backend
// serves, in the brand's quiet register: what happened, what's left open, and a
// way back to the campaign. No transcript dump, no "Session Complete!" fanfare —
// closure, not a scoreboard.
//
// ux-run2 reshaped the page into a durable DOCUMENT (myth-r6b2p, myth-3lgh5,
// myth-8x3uh): an identity header (campaign eyebrow · session number, a
// display-scale title, a muted date/party record line), the summary rendered as
// the writer's blank-line paragraphs, the threads as a numbered index (hanging
// indent, mono markers — referable at the table), a quiet copy-link exit beside
// "Back to campaign", and the credit receipt demoted to a true footnote below
// the button so the document never ends on billing. The pending beat makes the
// wait a contract ("you don't have to stay") and seats the cluster in the upper
// third — the empty page below the rule is the recap's future home, and the
// poll streams the finished document into it.
//
// The analysis is ASYNC (written by an Opus job after finalize), so the read hook
// polls: a just-ended session shows the calm "writing up the recap" beat until the
// summary lands, then the prose. Enforced ignorance holds server-side — the
// endpoint never reads the secret-aware handoff.
//
// Structure: RecapRoute (param + Suspense) → RecapData (the polling read + the
// campaign-identity read) → RecapView (pure presentation — the TDD seam).

/** How long the copy-link acknowledgement holds before reverting. */
const COPIED_MS = 2_000

/** Resolved copy + formatting for the recap surface. */
interface RecapLabels {
  readonly title: string
  readonly sessionLabel: (n: number) => string
  readonly formatDate: (iso: string) => string
  readonly summaryHeading: string
  readonly threadsHeading: string
  readonly threadsKeep: string
  readonly cost: string
  readonly pending: string
  readonly waitContract: string
  readonly copyLink: string
  readonly copied: string
  readonly empty: string
  readonly back: string
}

/** The campaign identity the header carries (myth-r6b2p) — resolved from the
 *  hub payload; null while loading / when the campaign isn't found (the header
 *  degrades to the session label alone, never a fake identity). */
export interface RecapIdentity {
  readonly campaignName: string
  readonly party: readonly string[]
}

function buildLabels(t: TFunction, locale: string): RecapLabels {
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'long' })
  return {
    title: t('recap.title'),
    sessionLabel: (n: number) => t('recap.sessionLabel', { number: n }),
    formatDate: (iso: string) => dateFormat.format(new Date(iso)),
    summaryHeading: t('recap.summaryHeading'),
    threadsHeading: t('recap.threadsHeading'),
    threadsKeep: t('recap.threadsKeep'),
    cost: t('recap.cost'),
    pending: t('recap.pending'),
    waitContract: t('recap.waitContract'),
    copyLink: t('recap.copyLink'),
    copied: t('recap.copied'),
    empty: t('recap.empty'),
    back: t('recap.back'),
  }
}

/** The writer emits 1-4 short paragraphs separated by blank lines (ux-run2
 *  myth-3lgh5, prompt+schema co-evolved); older single-block summaries fall
 *  through as one paragraph. */
function splitParagraphs(summary: string): readonly string[] {
  return summary
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** The document header: campaign eyebrow · session number, display-scale title,
 *  and one muted mono record line (date played · who was at the table). */
function RecapHeader({
  recap,
  identity,
  labels,
}: {
  recap: SessionRecap
  identity: RecapIdentity | null
  labels: RecapLabels
}): React.JSX.Element {
  const sessionLabel = labels.sessionLabel(recap.sessionNumber)
  const eyebrow =
    identity !== null ? `${identity.campaignName} · ${sessionLabel}` : sessionLabel
  const record = [
    recap.endedAt !== null ? labels.formatDate(recap.endedAt) : null,
    identity !== null && identity.party.length > 0 ? identity.party.join(', ') : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <Stack gap={1}>
      <Text role="ui-label" data-testid="recap-eyebrow">
        {eyebrow}
      </Text>
      <Heading level={1} role="display">
        {labels.title}
      </Heading>
      {record !== '' && (
        <Text role="meta" as="p" data-testid="recap-record">
          {record}
        </Text>
      )}
    </Stack>
  )
}

/** The emerging threads as a paper INDEX (myth-3lgh5): a mono kicker-style
 *  marker per item with the prose hanging beside it, so five threads read as
 *  five and the table can say "thread 2". Shared with the campaign hub's
 *  last-session block (myth-8x3uh). */
export function ThreadIndexList({ threads }: { threads: readonly string[] }): React.JSX.Element {
  return (
    <Stack gap={2}>
      {threads.map((thread, i) => (
        <Stack key={i} direction="row" gap={3} align="start">
          <Text role="ui-label" noShrink data-testid={`recap-thread-marker-${String(i + 1)}`}>
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text role="prose-body" as="p">
            {thread}
          </Text>
        </Stack>
      ))}
    </Stack>
  )
}

/** The quiet copy-link exit (myth-3lgh5) — a ghost text action over the injected
 *  clipboard port, acknowledging with a transient label flip (the invite panel's
 *  pattern). */
function CopyLinkAction({
  labels,
  onCopyLink,
}: {
  labels: RecapLabels
  onCopyLink: () => Promise<void>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  const onPress = (): void => {
    onCopyLink().then(
      () => {
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setCopied(false)
        }, COPIED_MS)
      },
      () => undefined,
    )
  }
  return (
    <Button variant="ghost" onPress={onPress} data-testid="recap-copy-link">
      {copied ? labels.copied : labels.copyLink}
    </Button>
  )
}

/** The exit ROW + receipt footnote: the outlined "Back to campaign" leads, the
 *  ghost copy-link sits to its right (ux-run3 myth-bbald — the primary exit is
 *  the eye's landing point, and the row shape alone tells the ghost apart from
 *  the narrator line above), then a rule and the credit line BELOW (myth-8x3uh)
 *  — logistics last, so the document ends on its own words, not on billing. */
function RecapTail({
  labels,
  onBack,
  onCopyLink,
}: {
  labels: RecapLabels
  onBack: () => void
  onCopyLink?: (() => Promise<void>) | undefined
}): React.JSX.Element {
  return (
    <Stack gap={4}>
      <Stack direction="row" wrap gap={2} align="center">
        <Button variant="secondary" onPress={onBack} data-testid="recap-back">
          {labels.back}
        </Button>
        {onCopyLink !== undefined && <CopyLinkAction labels={labels} onCopyLink={onCopyLink} />}
      </Stack>
      <Stack gap={3}>
        <Divider />
        <Text role="meta" as="p" data-testid="recap-cost">
          {labels.cost}
        </Text>
      </Stack>
    </Stack>
  )
}

/** Pure recap presentation. `recap` is null when the campaign has no ended session
 *  (the empty beat); `pending` while the async analysis is still being written;
 *  `ready` renders the document. Isolated from the fetch so it unit-tests directly. */
export function RecapView({
  recap,
  identity,
  labels,
  onBack,
  onCopyLink,
}: {
  recap: SessionRecap | null
  identity: RecapIdentity | null
  labels: RecapLabels
  onBack: () => void
  onCopyLink?: () => Promise<void>
}): React.JSX.Element {
  if (recap === null) {
    return (
      <Stack gap={4} maxWidth="prose" data-testid="route-recap">
        <Stack gap={1}>
          {identity !== null && (
            <Text role="ui-label" data-testid="recap-eyebrow">
              {identity.campaignName}
            </Text>
          )}
          <Heading level={1} role="display">
            {labels.title}
          </Heading>
        </Stack>
        <Text role="ui-caption" as="p" data-testid="recap-empty">
          {labels.empty}
        </Text>
        <Stack direction="row">
          <Button variant="secondary" onPress={onBack} data-testid="recap-back">
            {labels.back}
          </Button>
        </Stack>
      </Stack>
    )
  }

  if (recap.status === 'pending') {
    // The post-end beat (myth-r6b2p): the cluster seats in the upper third
    // (grow-weighted spacers), the wait makes a contract, and the rule above the
    // receipt marks the page below as the recap's future home — anticipation,
    // not absence. The poll streams the document into this same page.
    return (
      <Stack maxWidth="prose" minHeight="page" data-testid="route-recap">
        <Stack grow={1} />
        <Stack gap={5}>
          <RecapHeader recap={recap} identity={identity} labels={labels} />
          <Stack gap={2} data-testid="recap-pending">
            <Stack direction="row" gap={2} align="center">
              <Spinner size="xs" tone="accent" />
              <Text role="ui-caption" as="p">
                {labels.pending}
              </Text>
            </Stack>
            <Text role="meta" as="p" data-testid="recap-wait-contract">
              {labels.waitContract}
            </Text>
          </Stack>
          <RecapTail labels={labels} onBack={onBack} onCopyLink={onCopyLink} />
        </Stack>
        <Stack grow={2} />
      </Stack>
    )
  }

  const paragraphs = recap.summary !== undefined ? splitParagraphs(recap.summary) : []
  const threads = recap.emergingThreads ?? []
  return (
    <Stack gap={5} maxWidth="prose" data-testid="route-recap">
      <RecapHeader recap={recap} identity={identity} labels={labels} />
      <Stack gap={5} data-testid="recap-ready">
        <Stack gap={2}>
          <Text role="ui-label">{labels.summaryHeading}</Text>
          <Stack gap={3} data-testid="recap-summary">
            {paragraphs.map((paragraph, i) => (
              <Text key={i} role="prose-body" as="p">
                {paragraph}
              </Text>
            ))}
          </Stack>
        </Stack>
        {threads.length > 0 && (
          <Stack gap={2} data-testid="recap-threads">
            <Text role="ui-label">{labels.threadsHeading}</Text>
            <ThreadIndexList threads={threads} />
          </Stack>
        )}
      </Stack>
      {/* One step MORE air between the narrator line and the exit row than the
          line has above it (myth-bbald) — the mono narrator line and the ghost
          action must not read as the same species. */}
      <Stack gap={4}>
        {threads.length > 0 && (
          <Text role="meta" as="p" data-testid="recap-threads-keep">
            {labels.threadsKeep}
          </Text>
        )}
        <RecapTail labels={labels} onBack={onBack} onCopyLink={onCopyLink} />
      </Stack>
    </Stack>
  )
}

/** The polling read + the campaign-identity read + navigation wire. Suspends on
 *  first load; subsequent polls are background (the pending beat, not the
 *  fallback, shows while the analysis is written). The identity read reuses the
 *  hub payload and degrades to null on any failure — the recap never blocks on
 *  its own provenance. */
function RecapData({ campaignId, labels }: { campaignId: string; labels: RecapLabels }): React.JSX.Element {
  const navigate = useNavigate()
  const ctx = useApiContext()
  const { data } = useSessionRecap(campaignId)
  const [identity, setIdentity] = useState<RecapIdentity | null>(null)

  useEffect(() => {
    let active = true
    getMyCampaigns(undefined, ctx)
      .then((r) => {
        if (!active) return
        const campaign = r.campaigns.find((c) => c.id === campaignId)
        if (campaign !== undefined) {
          setIdentity({
            campaignName: campaign.name,
            party: campaign.party.map((m) => m.displayName),
          })
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [ctx, campaignId])

  const onCopyLink = useCallback(
    () => copyText(absoluteUrl(`/campaigns/${campaignId}/recap`)),
    [campaignId],
  )

  return (
    <RecapView
      recap={data.recap}
      identity={identity}
      labels={labels}
      onBack={() => {
        void navigate(`/campaigns/${campaignId}`)
      }}
      onCopyLink={onCopyLink}
    />
  )
}

export function RecapRoute(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const labels = buildLabels(t, i18n.language)
  // The route param is always present for a matched `/campaigns/:id/recap`; the
  // guard keeps the type narrow and renders the calm empty beat if it's ever absent.
  if (id === undefined) {
    return <RecapView recap={null} identity={null} labels={labels} onBack={() => undefined} />
  }
  return (
    <Suspense fallback={<Spinner />}>
      <RecapData campaignId={id} labels={labels} />
    </Suspense>
  )
}
