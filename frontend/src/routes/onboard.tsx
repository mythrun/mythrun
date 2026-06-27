import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Stack, Card, Heading, Text, Input, Button, Dither, ThemeToggle, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  useSessionStore,
  deriveUsername,
  checkUsername,
  register,
  isLocalPath,
  useApiContext,
  isHttpError,
} from '@mythrun/client-core'

// The onboarding moment (§11, matches onboard-modes.html): the genesis crown (the
// `flip`ped Dither, accent-dense at the top edge fading down into the page), the
// serif "What should we call you?" as the question-that-IS-the-label (gentler than
// a form), ONE pre-filled Input, a single ember PRIMARY Button, the theme FAB. The
// pre-fill name + return-to ride the callback→onboard router location state (the
// OAuth state was already single-use-consumed at the callback, §7); on reload the
// state is absent → the pre-fill gracefully empties and the user types.
//
// Submit: derive a regex-valid handle → probe check-username for a free candidate
// (≤3 local candidates; check-username has NO server suggestion, so a taken
// candidate is re-mutated locally) → register ONCE (with a bounded race retry) →
// setReady → return-to. Error taxonomy: display_name_invalid → inline on the
// (only visible) field; already_onboarded(_same) → already done, setReady;
// username_taken / username_invalid → fresh candidate, retry (≤3); 429/other →
// a friendly notice.
const MAX_ATTEMPTS = 3
const SUFFIX_LEN = 3
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function freshCandidate(base: string): string {
  let s = ''
  for (let i = 0; i < SUFFIX_LEN; i++) s += ALNUM.charAt(Math.floor(Math.random() * ALNUM.length))
  return (base.slice(0, 20 - SUFFIX_LEN) + s).slice(0, 20)
}

// The deterministic register-error → next-action map (a pure classifier, no I/O —
// the orchestration stays in `submit`). `done` = already onboarded, treat as
// success; `field` = the display name was rejected (inline error); `retry` = the
// username collided / was invalid (fresh candidate, bounded); `fail` = 429 or
// anything else (a friendly notice, no loop).
type RegisterAction = 'done' | 'field' | 'retry' | 'fail'

function classifyRegisterError(err: { status: number; code?: string }): RegisterAction {
  if (err.status === 409 && (err.code === 'already_onboarded' || err.code === 'already_onboarded_same')) return 'done'
  if (err.status === 400 && err.code === 'display_name_invalid') return 'field'
  if (err.status === 409 && err.code === 'username_taken') return 'retry'
  if (err.status === 400 && err.code === 'username_invalid') return 'retry'
  return 'fail'
}

export function OnboardRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const ctx = useApiContext()
  const { state } = useLocation() as { state: { name?: string | null; returnTo?: string } | null }

  const [name, setName] = useState<string>(state?.name ?? '')
  const [fieldError, setFieldError] = useState(false)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const returnTo = state?.returnTo !== undefined && isLocalPath(state.returnTo) ? state.returnTo : '/home'
  const sub = useSessionStore.getState().sub ?? ''

  const finish = (): void => {
    useSessionStore.getState().setReady(sub)
    void navigate(returnTo, { replace: true })
  }

  const submit = async (): Promise<void> => {
    setFieldError(false)
    setError(false)
    setBusy(true)
    try {
      const base = deriveUsername(name)
      // Probe up to MAX_ATTEMPTS candidates for a free one (cheap, 10/min).
      let candidate = base
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await checkUsername(candidate, ctx)
        if (res.available) break
        candidate = freshCandidate(base)
      }
      // Register ONCE (bounded race retry on a taken/invalid candidate).
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await register({ username: candidate, displayName: name }, ctx)
          finish()
          return
        } catch (err) {
          if (!isHttpError(err)) throw err
          const action = classifyRegisterError(err)
          if (action === 'done') { finish(); return }
          if (action === 'field') { setFieldError(true); return }
          if (action === 'fail') { setError(true); return }
          // 'retry': fresh candidate, fall through to the next bounded attempt.
          candidate = freshCandidate(base)
        }
      }
      setError(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // The crown palette (from/to PALETTE tokens, same as sign-in): light dithers the
  // parchment field → ember; dark dithers the reversed ground → cream. `flip` hangs the
  // accent DENSE at the top edge. Held as a const so the token names aren't JSX literals.
  const crown = theme === 'dark' ? ({ from: 'paper-900', to: 'paper-100' } as const) : ({ from: 'paper-100', to: 'ember-600' } as const)

  return (
    <Stack minHeight="screen" data-testid="route-onboard">
      <ThemeToggle label={t('theme.toggle')} data-testid="onboard-theme-toggle" />
      <Dither from={crown.from} to={crown.to} flip data-testid="onboard-crown" />
      {/* Same below-crown layout as sign-in: content seated OPTICALLY ABOVE center on
          desktop via the 1/4 spacer Stacks (seated high, more quiet space below than above), and the
          card collapses to native/inline on mweb (`Card collapse`). */}
      <Stack grow align="center">
        <Stack grow={1} />
        <Card collapse data-testid="onboard-card">
          <Stack align="center" gap={5}>
            <Heading level={1} role="title" data-testid="onboard-prompt">
              {t('onboard.prompt')}
            </Heading>
            <Input
              value={name}
              onChange={setName}
              size="lg"
              invalid={fieldError}
              aria-label={t('onboard.nameLabel')}
              data-testid="onboard-input"
            />
            {fieldError ? (
              <Text role="ui-caption" data-testid="onboard-field-error">
                {t('onboard.errors.displayNameInvalid')}
              </Text>
            ) : null}
            {error ? (
              <Text role="ui-caption" data-testid="onboard-error">
                {t('onboard.errors.generic')}
              </Text>
            ) : null}
            <Stack align="stretch" gap={3}>
              <Button variant="primary" loading={busy} onPress={() => { void submit() }}>
                {t('onboard.continue')}
              </Button>
            </Stack>
            <Text role="ui-caption" data-testid="onboard-hint">
              {t('onboard.hint')}
            </Text>
          </Stack>
        </Card>
        <Stack grow={4} />
      </Stack>
    </Stack>
  )
}
