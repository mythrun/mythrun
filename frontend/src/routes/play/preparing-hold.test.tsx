import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { ApiContext, SessionPrepStream, StageTiming } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { PreparingHold } from './preparing-hold.tsx'

// PreparingHold — the between-sessions atmospheric wait (MYT-92 T16; MYT-102;
// ux-run2 myth-i2pdo). The hold's estimate/stall precedence is covered through
// the session-lifecycle suite; this file pins the run-2 texture wiring THIS
// route owns: the six public-tier whisper lines threaded to the DS beat's
// rotating ledger, and the permission-to-leave line (backed by the start-flow
// hook's poll-on-return behavior — stepping away costs nothing).

const CTX = { baseUrl: 'http://test', fetchFn: vi.fn() } as unknown as ApiContext
const CAMPAIGN_ID = 'c1'

const generatingPrep = (): SessionPrepStream => ({ status: 'generating', terminal: false })
const noTimings = (): Promise<readonly StageTiming[]> => Promise.resolve([])

function renderHold(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <PreparingHold
        ctx={CTX}
        campaignId={CAMPAIGN_ID}
        reducedMotion={false}
        onRetry={() => undefined}
        usePrep={generatingPrep}
        fetchTimings={noTimings}
      />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('PreparingHold — the run-2 long-wait texture (myth-i2pdo)', () => {
  it('threads the six public-tier whisper lines to the beat (one shows as the current whisper)', () => {
    renderHold()
    const whispers = [
      i18n.t('play.preparing.flavor1'),
      i18n.t('play.preparing.flavor2'),
      i18n.t('play.preparing.flavor3'),
      i18n.t('play.preparing.flavor4'),
      i18n.t('play.preparing.flavor5'),
      i18n.t('play.preparing.flavor6'),
    ]
    expect(new Set(whispers).size).toBe(6)
    expect(whispers).toContain(screen.getByTestId('whisper-ledger-current').textContent)
  })

  it('grants permission to leave with the i18n line', () => {
    renderHold()
    expect(screen.getByTestId('session-preparing-leave').textContent).toBe(
      i18n.t('play.preparing.safeToLeave'),
    )
  })
})
