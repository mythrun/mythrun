import { useEffect, useState } from 'react'
import { Stack, Text, Button, SeamlessInput, Icon, Grid, Divider } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  startSynthesisStream,
  useApiContext,
  isHttpError,
  readGuidedDraft,
  writeGuidedDraft,
  type GuidedDraft,
  type GuidedPickDraft,
  type SynthesisStream,
} from '@mythrun/client-core'

// The campaign-create GUIDED screen (spec §1, "Build from what you love") — the
// player names three things they love, one at a time, and the synthesizer turns
// them into a concept preview. A quiet eyebrow + a faint 3-tick progress
// affordance frame each step; the serif question-that-IS-the-label sits over a
// name field + a multiline "why" field. `Next →` advances (steps 1-2), `Find my
// world →` opens the synthesis STREAM (step 3, myth-umggn), and a `← Back`
// steps back (steps 2-3) with the picks PERSISTED in component state. The picks
// also round-trip through sessionStorage (the client-core draft seam) so a
// mid-flow reload re-prefills.
//
// myth-umggn: the synthesis is a one-shot SSE POST (`startSynthesisStream`).
// This screen owns the OPEN — so every pre-stream failure (400/429/403/
// network) keeps today's calm inline notices, right here where the player can
// act on them — and hands the live stream to the controller (onStreaming) the
// moment the 200 head arrives; the SYNTHESIZING screen renders the arriving
// brief and owns the post-open terminals (complete / rejected / failed).
// Pure presentation + that ONE side effect: the screen fires NEUTRAL intents
// and never navigates itself. Composes @mythrun/ui only (no ad-hoc UI); every
// string is an i18n `[ph:]` key (R5).

type Step = 1 | 2 | 3
type Picks = [GuidedPickDraft, GuidedPickDraft, GuidedPickDraft]

const STEP_KEYS = ['one', 'two', 'three'] as const
// Field bounds mirror the contract `SynthesizerPickSchema` (title 1..200,
// whyILikeIt 1..800): the action stays disabled — QUIETLY, no red error — until
// the current pick (and, on the last step, all three) satisfies them.
const TITLE_MAX = 200
const WHY_MAX = 800

const EMPTY_PICK: GuidedPickDraft = { title: '', whyILikeIt: '' }
const INITIAL_DRAFT: GuidedDraft = { picks: [EMPTY_PICK, EMPTY_PICK, EMPTY_PICK], step: 1 }

// A transient, calm inline notice after a NON-rejection failure. `retry` is the
// try-again nudge (503 upstream + any unexpected error); `cooldown` is the calm
// wait-a-moment after a rejection-storm rate limit; `credits` nudges a top-up.
interface Notice {
  kind: 'retry' | 'cooldown' | 'credits'
}

export interface GuidedScreenProps {
  /** The synthesis stream OPENED (200 head) → the controller advances to the
   *  synthesizing screen, which renders the arriving brief and routes the
   *  terminals (complete → preview, rejected/content_filtered → rejection). */
  onStreaming: (stream: SynthesisStream) => void
  /** Chose the quiet switch line → the controller advances to `freeform`. */
  onFreeform: () => void
}

/** A pick is ready when both fields are non-blank and within the contract bounds. */
function pickReady(pick: GuidedPickDraft): boolean {
  const title = pick.title.trim()
  const why = pick.whyILikeIt.trim()
  return title.length >= 1 && title.length <= TITLE_MAX && why.length >= 1 && why.length <= WHY_MAX
}

/** Map an OPEN failure to its calm inline notice. The gate verdicts
 *  (concept_rejected / content_filtered) can no longer arrive here — the gate
 *  runs AFTER the stream opens, so those are the synthesizing screen's
 *  terminals (myth-umggn); everything the guard chain rejects pre-stream
 *  lands in these three notices, exactly as before. */
function noticeFor(err: unknown): Notice {
  if (isHttpError(err)) {
    if (err.code === 'rejection_storm_cooldown') return { kind: 'cooldown' }
    if (err.code === 'insufficient_credits') return { kind: 'credits' }
  }
  return { kind: 'retry' }
}

// A faint 3-tick progress affordance composed from DS primitives (Grid + Divider)
// — the guided INPUT gets a step indicator (distinct from the world-GEN
// no-progress-bar rule). Completed/current ticks read as the ink seam; pending
// ticks stay the quiet decorative hairline.
function StepTicks({ step }: { step: Step }): React.JSX.Element {
  return (
    <Grid columns={3} gap={2} data-testid="guided-step-ticks">
      {[1, 2, 3].map((tick) => (
        <Divider key={tick} tone={tick <= step ? 'ink' : 'border'} />
      ))}
    </Grid>
  )
}

// The quiet eyebrow + the faint tick affordance + the per-step "N of three" marker.
function StepHeader({ step }: { step: Step }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={2}>
      <Text role="ui-label" data-testid="guided-eyebrow">
        {t('campaignNew.guided.eyebrow')}
      </Text>
      <StepTicks step={step} />
      <Text role="meta" data-testid="guided-step-marker">
        {t(`campaignNew.guided.step.${STEP_KEYS[step - 1] ?? 'one'}`)}
      </Text>
    </Stack>
  )
}

// The one-at-a-time pick fields: the name (autofocused, re-keyed per step so the
// caret lands on each new step) over the multiline "why".
function PickFields({
  step,
  pick,
  onPatch,
}: {
  step: Step
  pick: GuidedPickDraft
  onPatch: (patch: Partial<GuidedPickDraft>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4}>
      <SeamlessInput
        key={step}
        autoFocus
        label={t('campaignNew.guided.nameQuestion')}
        value={pick.title}
        onChange={(v) => { onPatch({ title: v }) }}
        data-testid="guided-name-input"
      />
      <SeamlessInput
        multiline
        label={t('campaignNew.guided.whyQuestion')}
        value={pick.whyILikeIt}
        onChange={(v) => { onPatch({ whyILikeIt: v }) }}
        data-testid="guided-why-input"
      />
    </Stack>
  )
}

// The `← Back` (steps 2-3) + the primary `Next →` / `Find my world →` action.
function StepActions({
  step,
  busy,
  ready,
  onBack,
  onAdvance,
}: {
  step: Step
  busy: boolean
  ready: boolean
  onBack: () => void
  onAdvance: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack direction="row" gap={3} align="center">
      {step > 1 ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="arrow-left" decorative />}
          onPress={onBack}
          data-testid="guided-back"
        >
          {t('back')}
        </Button>
      ) : null}
      <Button
        variant="primary"
        loading={busy}
        disabled={!ready}
        onPress={onAdvance}
        data-testid="guided-advance"
      >
        {t(step < 3 ? 'campaignNew.guided.next' : 'campaignNew.guided.find')}
      </Button>
    </Stack>
  )
}

export function GuidedScreen({ onStreaming, onFreeform }: GuidedScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const [draft] = useState<GuidedDraft>(() => readGuidedDraft() ?? INITIAL_DRAFT)
  const [picks, setPicks] = useState<Picks>(draft.picks)
  const [step, setStep] = useState<Step>(draft.step)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Round-trip the in-progress picks through sessionStorage (spec §11) so a reload
  // re-prefills; the store no-ops when unconfigured (tests / native-not-yet).
  useEffect(() => {
    writeGuidedDraft({ picks, step })
  }, [picks, step])

  // step ∈ {1,2,3} and picks is a 3-tuple, so the index is always in range; the
  // `?? EMPTY_PICK` fallback only satisfies noUncheckedIndexedAccess (never fires).
  const idx = step - 1
  const current = picks[idx] ?? EMPTY_PICK
  const advanceReady = step < 3 ? pickReady(current) : picks.every(pickReady)

  const patchCurrent = (patch: Partial<GuidedPickDraft>): void => {
    setNotice(null)
    setPicks((prev) => {
      const base = prev[idx] ?? EMPTY_PICK
      const next: Picks = [prev[0], prev[1], prev[2]]
      next[idx] = { ...base, ...patch }
      return next
    })
  }

  const back = (): void => {
    setNotice(null)
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s))
  }

  const findWorld = async (): Promise<void> => {
    setNotice(null)
    setBusy(true)
    try {
      const body = picks.map((p) => ({ title: p.title.trim(), whyILikeIt: p.whyILikeIt.trim() }))
      // myth-umggn: open the synthesis STREAM. The promise resolves on the 200
      // head (the brief starts arriving); a guard trip (429 cooldown, 403
      // credits, 400) rejects with the same HttpError taxonomy the synchronous
      // endpoint threw, so the calm notices below are unchanged.
      const stream = await startSynthesisStream(ctx, { picks: body })
      // Note: the draft is NOT cleared here — it survives synthesize → preview so a
      // "start over" or a 410 preview-expired restart re-prefills the picks (§11).
      // The controller clears it only once a campaign is actually committed.
      onStreaming(stream)
    } catch (err) {
      setNotice(noticeFor(err))
    } finally {
      setBusy(false)
    }
  }

  const advance = (): void => {
    if (step < 3) {
      setStep((s) => (s + 1) as Step)
      return
    }
    void findWorld()
  }

  return (
    <Stack gap={5} data-testid="screen-guided">
      <StepHeader step={step} />
      <PickFields step={step} pick={current} onPatch={patchCurrent} />
      {notice ? (
        <Text role="ui-caption" data-testid="guided-notice">
          {t(`campaignNew.guided.${notice.kind}`)}
        </Text>
      ) : null}
      <StepActions step={step} busy={busy} ready={advanceReady} onBack={back} onAdvance={advance} />
      {step === 1 ? (
        <Stack align="start">
          <Button variant="ghost" size="sm" onPress={onFreeform} data-testid="guided-switch">
            {t('campaignNew.guided.switchToFreeform')}
          </Button>
        </Stack>
      ) : null}
    </Stack>
  )
}
