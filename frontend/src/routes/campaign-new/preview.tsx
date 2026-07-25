import { useState } from 'react'
import { Stack, Text, Button, SeamlessInput, Divider, Box } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  createCampaign,
  reworkPreview,
  readGuidedDraft,
  useApiContext,
  isHttpError,
  GATE_REASONS,
  type ConceptRejection,
  type GateReason,
} from '@mythrun/client-core'
import type { RejectionState } from './rejection.tsx'

// The campaign-create PREVIEW beat (spec §1) — the guided path's one moment of
// judgement before ~10 minutes of world generation. The synthesizer parked a
// gated concept under an opaque previewId; this screen renders that concept as
// serif prose (NO world name — the wire carries previewId + concept only; the
// name is minted later, during world-gen; we never fabricate one) and offers
// three moves:
//
//   - Begin       → commit the guided preview (`createCampaign` with the wrapped
//                   `{mode:'guided', previewId}` body); the controller navigates.
//   - Ask for one change → reveal a borderless change-note field; `Rework`
//                   revises the parked concept ONCE (`reworkPreview`). On success
//                   the revised concept replaces the shown one and the single
//                   change is SPENT — Begin becomes the only action.
//   - Start over  → discard the preview, back to the guided picks — behind a
//                   TWO-STEP inline confirm (see below).
//
// THE ACTION ROW CONTRACT (ux-run2 myth-fca4y): the commit and the discard must
// never share a verb ("Begin" / "Begin again" was a loaded gun) — the discard is
// "Start over", ISOLATED at the far right of the row (keep-actions left,
// discard alone on the right: distance is the confirmation), and its first
// activation swaps the control row IN PLACE to an inline confirm ("Start over?
// This discards the current draft.") — nothing is discarded on one press. A
// muted cost line under the primary discloses the commitment ("Building your
// world takes a few minutes."). A hairline rule seats the action zone and the
// page ends with real bottom breathing, not an abrupt cut.
//
// THE PROSE IS NOT A WALL (ux-run2 myth-ia9v2): the concept renders as real
// PARAGRAPHS at its blank-line seams (a mechanical split — no semantic parsing)
// on a capped reading measure, and a compact keep-pair sits ABOVE the prose so
// the first viewport already shows a decision exists; the full row at the end
// of the document stays (its placement is praised — critique 010).
//
// Pure presentation + two side effects (commit, rework) firing NEUTRAL intents —
// the screen never navigates itself; the controller maps `onCommitted` /
// `onPreviewExpired` (a commit-time 410) / `onRejected` (a rework the gate
// rejects, or the terminal content-filter) to routes/screens. Composes
// @mythrun/ui only (no ad-hoc UI); every string is an i18n key (R5).

// Mirrors `ReworkRequestSchema.change.max(800)` — a change note is a sentence or
// two; Rework stays disabled (quietly) until the note is non-blank and in bound.
const CHANGE_MAX = 800

// A transient, calm inline notice after a NON-routing failure (mirrors the
// guided screen): `retry` for a transient upstream error, `cooldown` after a
// rejection-storm rate limit, `credits` when the balance can't cover world-gen.
interface Notice {
  kind: 'retry' | 'cooldown' | 'credits'
}

/** The synthesized preview the guided path parks under an opaque id. */
export interface PreviewPayload {
  previewId: string
  concept: string
}

export interface PreviewScreenProps {
  /** The synthesized concept + its opaque previewId (carried from guided synthesis). */
  payload: PreviewPayload
  /** Committed the preview (HTTP 201) → the controller advances to the generating route. */
  onCommitted: (campaignId: string) => void
  /** CONFIRMED "start over" → the controller returns to the guided picks. */
  onStartOver: () => void
  /** The preview aged out at commit (410) → the controller restarts the guided flow. */
  onPreviewExpired: () => void
  /** A rework was gate-rejected (or content-filtered) → the controller shows the rejection screen. */
  onRejected: (rejection: RejectionState) => void
}

/** Build the minimal ConceptRejection the controller carries, read defensively off the error body. */
function conceptRejectionFrom(body: unknown): ConceptRejection {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const reason =
    typeof b.reason === 'string' && (GATE_REASONS as readonly string[]).includes(b.reason)
      ? (b.reason as GateReason)
      : 'inappropriate'
  const rejectionMessage = typeof b.rejectionMessage === 'string' ? b.rejectionMessage : null
  const synthesizedConcept = typeof b.synthesizedConcept === 'string' ? b.synthesizedConcept : undefined
  return {
    code: 'concept_rejected',
    reason,
    rejectionMessage,
    ...(synthesizedConcept !== undefined ? { synthesizedConcept } : {}),
  }
}

// A rework can end four ways: routed to the rejection screen (gate reject OR the
// terminal content-filter), the single-change budget already spent (409 — gated
// at one in-UI, so defensive), or a calm inline notice for a transient failure.
interface ReworkOutcome {
  rejection?: RejectionState
  exhausted?: boolean
  notice?: Notice
}

function reworkOutcome(err: unknown): ReworkOutcome {
  if (isHttpError(err)) {
    if (err.code === 'content_filtered') return { rejection: { code: 'content_filtered' } }
    if (err.code === 'concept_rejected') return { rejection: conceptRejectionFrom(err.body) }
    if (err.code === 'rework_exhausted') return { exhausted: true }
    if (err.code === 'rejection_storm_cooldown') return { notice: { kind: 'cooldown' } }
    if (err.code === 'insufficient_credits') return { notice: { kind: 'credits' } }
  }
  return { notice: { kind: 'retry' } }
}

// A commit can end three ways: the preview expired (410 → restart guided), a
// blocking cost/rate condition (403/429 → calm inline notice), or a transient
// failure (→ calm try-again). A guided commit does not re-run the gate (the
// preview is already gated), so there is no concept-rejection branch here.
interface CommitOutcome {
  expired?: boolean
  notice?: Notice
}

function commitOutcome(err: unknown): CommitOutcome {
  if (isHttpError(err)) {
    if (err.code === 'preview_expired') return { expired: true }
    if (err.code === 'insufficient_credits') return { notice: { kind: 'credits' } }
    if (err.code === 'rejection_storm_cooldown') return { notice: { kind: 'cooldown' } }
  }
  return { notice: { kind: 'retry' } }
}

// The screen's action surface: the resting three-action row (`view`), the
// change-note form (`change`), or the in-place start-over confirm (`confirm`).
type Phase = 'view' | 'change' | 'confirm'

// The full preview view-model (state + the two side effects) so the presentation
// component below stays a thin render. `spent` latches once the single rework
// succeeds (or a defensive 409); `phase` toggles the change-note field / the
// start-over confirm.
function usePreview(
  payload: PreviewPayload,
  intents: Pick<PreviewScreenProps, 'onCommitted' | 'onPreviewExpired' | 'onRejected'>,
) {
  const ctx = useApiContext()
  const [concept, setConcept] = useState(payload.concept)
  const [phase, setPhase] = useState<Phase>('view')
  const [spent, setSpent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [change, setChange] = useState('')

  const begin = async (): Promise<void> => {
    setNotice(null)
    setBusy(true)
    try {
      const res = await createCampaign(ctx, {
        world: { kind: 'new', source: { mode: 'guided', previewId: payload.previewId } },
      })
      intents.onCommitted(res.campaignId)
    } catch (err) {
      const out = commitOutcome(err)
      if (out.expired === true) intents.onPreviewExpired()
      else setNotice(out.notice ?? { kind: 'retry' })
    } finally {
      setBusy(false)
    }
  }

  const rework = async (): Promise<void> => {
    setNotice(null)
    setBusy(true)
    try {
      const res = await reworkPreview(ctx, payload.previewId, { change: change.trim() })
      setConcept(res.concept)
      setSpent(true)
      setPhase('view')
    } catch (err) {
      const out = reworkOutcome(err)
      if (out.rejection !== undefined) intents.onRejected(out.rejection)
      else if (out.exhausted === true) { setSpent(true); setPhase('view') }
      else setNotice(out.notice ?? { kind: 'retry' })
    } finally {
      setBusy(false)
    }
  }

  return { concept, phase, setPhase, spent, busy, notice, setNotice, change, setChange, begin, rework }
}

// The compact keep-pair ABOVE the prose (ux-run2 myth-ia9v2): from the first
// viewport the decision is visible — Begin, and (until spent) the quiet
// adjust. The discard does NOT ride up here; it stays isolated at the end of
// the document, far from the skim path.
function TopActions({
  busy,
  spent,
  onBegin,
  onAskChange,
}: {
  busy: boolean
  spent: boolean
  onBegin: () => void
  onAskChange: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack direction="row" gap={3} align="center" data-testid="preview-actions-top">
      <Button variant="primary" loading={busy} onPress={onBegin} data-testid="preview-begin-top">
        {t('campaignNew.preview.begin')}
      </Button>
      {!spent ? (
        <Button variant="ghost" size="sm" onPress={onAskChange} data-testid="preview-ask-change-top">
          {t('campaignNew.preview.askChange')}
        </Button>
      ) : null}
    </Stack>
  )
}

// The resting end-of-document action row (placement praised — critique 010):
// keep-actions left, the discard ALONE on the right (distance is the
// confirmation), the muted commitment line under the primary.
function PreviewActions({
  busy,
  onBegin,
  onAskChange,
  onStartOver,
}: {
  busy: boolean
  onBegin: () => void
  onAskChange: () => void
  onStartOver: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={3}>
      <Stack direction="row" gap={3} align="center" justify="between" wrap>
        <Stack direction="row" gap={3} align="center">
          <Button variant="primary" loading={busy} onPress={onBegin} data-testid="preview-begin">
            {t('campaignNew.preview.begin')}
          </Button>
          <Button variant="ghost" size="sm" onPress={onAskChange} data-testid="preview-ask-change">
            {t('campaignNew.preview.askChange')}
          </Button>
        </Stack>
        <Button variant="ghost" size="sm" onPress={onStartOver} data-testid="preview-start-over">
          {t('campaignNew.preview.startOver')}
        </Button>
      </Stack>
      <Text role="meta" data-testid="preview-cost">
        {t('campaignNew.preview.cost')}
      </Text>
    </Stack>
  )
}

// The in-place start-over confirm (ux-run2 myth-fca4y): the control row swaps
// to the question + an explicit yes / keep pair — one press never discards.
function ConfirmStartOver({
  onConfirm,
  onKeep,
}: {
  onConfirm: () => void
  onKeep: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack direction="row" gap={3} align="center" wrap data-testid="preview-start-over-confirm">
      <Text role="ui-caption">{t('campaignNew.preview.startOverConfirm')}</Text>
      <Button variant="secondary" size="sm" onPress={onConfirm} data-testid="preview-start-over-yes">
        {t('campaignNew.preview.startOverYes')}
      </Button>
      <Button variant="ghost" size="sm" onPress={onKeep} data-testid="preview-start-over-keep">
        {t('campaignNew.preview.startOverKeep')}
      </Button>
    </Stack>
  )
}

// The one-change note field + Rework (disabled until the note is in bound) + a
// quiet back-out to the view actions.
function ChangeForm({
  value,
  onChange,
  busy,
  ready,
  onRework,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  busy: boolean
  ready: boolean
  onRework: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4}>
      <SeamlessInput
        multiline
        label={t('campaignNew.preview.changeQuestion')}
        value={value}
        onChange={onChange}
        data-testid="preview-change-input"
      />
      <Stack direction="row" gap={3} align="center">
        <Button
          variant="primary"
          loading={busy}
          disabled={!ready}
          onPress={onRework}
          data-testid="preview-rework"
        >
          {t('campaignNew.preview.rework')}
        </Button>
        <Button variant="ghost" size="sm" onPress={onCancel} data-testid="preview-change-cancel">
          {t('campaignNew.preview.cancelChange')}
        </Button>
      </Stack>
    </Stack>
  )
}

// After the single change is spent: the faint spent-note + Begin as the ONLY
// action (no further rework, no start-over) — the commitment line stays.
function SpentActions({ busy, onBegin }: { busy: boolean; onBegin: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack align="start" gap={3}>
      <Text role="ui-caption" data-testid="preview-change-spent">
        {t('campaignNew.preview.changeUsed')}
      </Text>
      <Button variant="primary" loading={busy} onPress={onBegin} data-testid="preview-begin">
        {t('campaignNew.preview.begin')}
      </Button>
      <Text role="meta" data-testid="preview-cost-spent">
        {t('campaignNew.preview.cost')}
      </Text>
    </Stack>
  )
}

export function PreviewScreen({
  payload,
  onCommitted,
  onStartOver,
  onPreviewExpired,
  onRejected,
}: PreviewScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const vm = usePreview(payload, { onCommitted, onPreviewExpired, onRejected })
  // The weave acknowledges what it wove (ux-run2 myth-8u3h3): the player's own
  // three named stories, read from the guided draft that deliberately survives
  // synthesize → preview. Absent/empty draft (a reload after commit, a cleared
  // tab) simply drops the line.
  const [wovenFrom] = useState(() =>
    (readGuidedDraft()?.picks ?? [])
      .map((pick) => pick.title.trim())
      .filter((title) => title.length > 0)
      .join(' · '),
  )
  const trimmed = vm.change.trim()
  const changeReady = trimmed.length >= 1 && trimmed.length <= CHANGE_MAX
  // Paragraphs at the concept's blank-line seams — a MECHANICAL split (ux-run2
  // myth-ia9v2; the same structural rendering the wiki introduction uses), so a
  // generator that emits breaks never renders as one collapsed wall.
  const paragraphs = vm.concept.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const begin = (): void => { void vm.begin() }
  return (
    <Stack gap={6} data-testid="screen-preview">
      {/* The kicker hugs the concept prose it introduces (one tight cluster),
          then a clear gap to the actions — the shared funnel hierarchy. */}
      <Stack gap={3}>
        <Text role="ui-label" data-testid="preview-eyebrow">
          {t('campaignNew.preview.eyebrow')}
        </Text>
        {wovenFrom !== '' && (
          <Text role="meta" as="p" data-testid="preview-woven-from">
            {t('campaignNew.preview.wovenFrom', { sources: wovenFrom })}
          </Text>
        )}
        {vm.phase === 'view' ? (
          <TopActions
            busy={vm.busy}
            spent={vm.spent}
            onBegin={begin}
            onAskChange={() => { vm.setPhase('change') }}
          />
        ) : null}
        {/* The prose column caps at the DS reading measure — a skimmable page,
            not a 75ch wall (ux-run2 myth-ia9v2). */}
        <Stack gap={4} maxWidth="prose" data-testid="preview-concept">
          {paragraphs.map((paragraph, i) => (
            <Text role="prose-body" as="p" key={i}>
              {paragraph}
            </Text>
          ))}
        </Stack>
        {vm.notice ? (
          <Text role="ui-caption" data-testid="preview-notice">
            {t(`campaignNew.preview.${vm.notice.kind}`)}
          </Text>
        ) : null}
      </Stack>
      {/* The action zone is seated by a hairline rule (ux-run2 myth-fca4y). */}
      <Stack gap={4}>
        <Divider />
        {vm.spent ? (
          <SpentActions busy={vm.busy} onBegin={begin} />
        ) : vm.phase === 'change' ? (
          <ChangeForm
            value={vm.change}
            onChange={vm.setChange}
            busy={vm.busy}
            ready={changeReady}
            onRework={() => { void vm.rework() }}
            onCancel={() => { vm.setPhase('view'); vm.setNotice(null) }}
          />
        ) : vm.phase === 'confirm' ? (
          <ConfirmStartOver onConfirm={onStartOver} onKeep={() => { vm.setPhase('view') }} />
        ) : (
          <PreviewActions
            busy={vm.busy}
            onBegin={begin}
            onAskChange={() => { vm.setPhase('change') }}
            onStartOver={() => { vm.setPhase('confirm') }}
          />
        )}
      </Stack>
      {/* The page ends with breathing room, not an abrupt cut (>=96px with the
          frame's own padding — ux-run2 myth-fca4y). */}
      <Box padding={5} surface="none" />
    </Stack>
  )
}
