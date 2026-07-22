import { render, screen } from '@testing-library/react'
import { I18nextProvider, Trans, useTranslation } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { i18n } from './config.ts'

// This proves the i18next RUNTIME behaviour of the real product instance (static
// resolution, `{{}}` interpolation, the missing-key fallback, and <Trans> markup
// slots) — not any particular product string. The two fixtures it drives
// (`appGreeting`, `richSample`) are NOT product keys; they live here as a
// test-only resource bundle so the runtime proof survives independent of the
// catalog's copy. `back` + the missing-key case still exercise the real instance.
beforeAll(() => {
  i18n.addResourceBundle(
    'en',
    'common',
    {
      appGreeting: 'Hello {{name}}',
      richSample: 'See <1>the link</1> here.',
    },
    true,
    true,
  )
})

function Probe(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <span data-testid="static">{t('back')}</span>
      {/* Typed keys reject these test-only fixtures at compile time (they are not
          product keys — the augmentation working as intended); the runtime call
          still resolves them from the bundle added above. */}
      {/* @ts-expect-error -- test-only fixture key, not in the product catalog */}
      <span data-testid="interp">{t('appGreeting', { name: 'Mara' })}</span>
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
        {/* @ts-expect-error -- test-only fixture key, not in the product catalog */}
        <Trans i18nKey="richSample" components={{ 1: <a href="#" /> }} />
      </I18nextProvider>,
    )
    expect(document.querySelector('a')).not.toBeNull()
  })
})
