import { describe, it, expectTypeOf } from 'vitest'
import type { BannerProps, Severity } from './banner.ts'

// Type-level contract for Banner. The runtime barrel is asserted value-free by
// contract.test.ts; here we pin the SHAPE so the native impl satisfies the same
// surface (a closed severity union, i18n content, a neutral dismiss callback —
// never a DOM event).
describe('BannerProps contract', () => {
  it('exposes the four-status closed Severity union', () => {
    expectTypeOf<Severity>().toEqualTypeOf<'success' | 'warning' | 'danger' | 'info'>()
  })

  it('requires a severity', () => {
    expectTypeOf<BannerProps>().toHaveProperty('severity').toEqualTypeOf<Severity>()
  })

  it('accepts the minimal body-only banner', () => {
    expectTypeOf<{ severity: Severity; children: string }>().toExtend<BannerProps>()
  })

  it('accepts an optional title (i18n key)', () => {
    expectTypeOf<BannerProps['title']>().toEqualTypeOf<string | undefined>()
  })

  it('exposes a neutral onDismiss callback (no DOM event)', () => {
    expectTypeOf<BannerProps['onDismiss']>().toEqualTypeOf<(() => void) | undefined>()
  })

  it('exposes dismissible + dismissLabel for the close control', () => {
    expectTypeOf<BannerProps['dismissible']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<BannerProps['dismissLabel']>().toEqualTypeOf<string | undefined>()
  })
})
