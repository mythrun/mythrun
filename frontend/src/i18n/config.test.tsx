import { render, screen } from '@testing-library/react'
import { I18nextProvider, Trans, useTranslation } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { i18n } from './config.ts'

function Probe(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <span data-testid="static">{t('back')}</span>
      <span data-testid="interp">{t('appGreeting', { name: 'Mara' })}</span>
      {/* Typed keys reject this unknown key at compile time (the augmentation
          working as intended); the test still needs the runtime call to assert
          i18next's missing-key fallback returns the full key string. */}
      {/* @ts-expect-error -- unknown i18n key: exercised for the runtime missing-key fallback assertion */}
      <span data-testid="missing">{t('does.not.exist')}</span>
    </>
  )
}

describe('i18n runtime', () => {
  it('resolves static, interpolated, and missing keys', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('static').textContent).toBe('Back')
    expect(screen.getByTestId('interp').textContent).toContain('Mara')
    expect(screen.getByTestId('missing').textContent).toBe('does.not.exist')
  })

  it('<Trans> renders the embedded-markup slot', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Trans i18nKey="richSample" components={{ 1: <a href="#" /> }} />
      </I18nextProvider>,
    )
    expect(document.querySelector('a')).not.toBeNull()
  })
})
