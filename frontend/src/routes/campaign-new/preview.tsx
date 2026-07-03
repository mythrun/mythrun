import { useState } from 'react'
import { Stack, Text, Button, SeamlessInput } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  createCampaign,
  reworkPreview,
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
// serif prose (NO world name — the name is minted later, during world-gen; we
// never fabricate one) and offers three moves:
//
//   - Begin       → commit the guided preview (`createCampaign` with the wrapped
//                   `{mode:'guided', previewId}` body); the controller navigates.
//   - Ask for one change → reveal a borderless change-note field; `Rework`
//                   revises the parked concept ONCE (`reworkPreview`). On success
//                   the revised concept replaces the shown one and the single
//                   change is SPENT — Begin becomes the only action.
//   - Start over  → discard the preview, back to the guided picks.
//
// Pure presentation + two side effects (commit, rework) firing NEUTRAL intents —
// the screen never navigates itself; the controller maps `onCommitted` /
// `onPreviewExpired` (a commit-time 410) / `onRejected` (a rework the gate
// rejects, or the terminal content-filter) to routes/screens. Composes
// @mythrun/ui only (no ad-hoc UI); every string is an i18n `[ph:]` key (R5).

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
  /** Chose "start over" → the controller returns to the guided picks. */
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

// The full preview view-model (state + the two side effects) so the presentation
// component below stays a thin render. `spent` latches once the single rework
// succeeds (or a defensive 409); `phase` toggles the change-note field.
function usePreview(
  payload: PreviewPayload,
  intents: Pick<PreviewScreenProps, 'onCommitted' | 'onPreviewExpired' | 'onRejected'>,
) {
  const ctx = useApiContext()
  const [concept, setConcept] = useState(payload.concept)
  const [phase, setPhase] = useState<'view' | 'change'>('view')
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

// The initial three-action row (Begin + the two muted alternatives).
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
    <Stack direction="row" gap={3} align="center">
      <Button variant="primary" loading={busy} onPress={onBegin} data-testid="preview-begin">
        {t('campaignNew.preview.begin')}
      </Button>
      <Button variant="ghost" size="sm" onPress={onAskChange} data-testid="preview-ask-change">
        {t('campaignNew.preview.askChange')}
      </Button>
      <Button variant="ghost" size="sm" onPress={onStartOver} data-testid="preview-start-over">
        {t('campaignNew.preview.startOver')}
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
// action (no further rework, no start-over).
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
  const trimmed = vm.change.trim()
  const changeReady = trimmed.length >= 1 && trimmed.length <= CHANGE_MAX
  return (
    <Stack gap={5} data-testid="screen-preview">
      <Text role="ui-label" data-testid="preview-eyebrow">
        {t('campaignNew.preview.eyebrow')}
      </Text>
      <Text role="prose-body" as="p" data-testid="preview-concept">
        {vm.concept}
      </Text>
      {vm.notice ? (
        <Text role="ui-caption" data-testid="preview-notice">
          {t(`campaignNew.preview.${vm.notice.kind}`)}
        </Text>
      ) : null}
      {vm.spent ? (
        <SpentActions busy={vm.busy} onBegin={() => { void vm.begin() }} />
      ) : vm.phase === 'change' ? (
        <ChangeForm
          value={vm.change}
          onChange={vm.setChange}
          busy={vm.busy}
          ready={changeReady}
          onRework={() => { void vm.rework() }}
          onCancel={() => { vm.setPhase('view'); vm.setNotice(null) }}
        />
      ) : (
        <PreviewActions
          busy={vm.busy}
          onBegin={() => { void vm.begin() }}
          onAskChange={() => { vm.setPhase('change') }}
          onStartOver={onStartOver}
        />
      )}
    </Stack>
  )
}
