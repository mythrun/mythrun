import { describe, it, expectTypeOf } from 'vitest'
import type { SpinnerProps } from './spinner.ts'

// Type-level contract for Spinner. Platform-neutral: a size token + an optional
// SR label (an i18n key the consumer supplies; the impl provides a fallback).
describe('SpinnerProps contract', () => {
  it('accepts the three token sizes', () => {
    expectTypeOf<SpinnerProps['size']>().toEqualTypeOf<'sm' | 'md' | 'lg' | undefined>()
  })

  it('accepts an optional SR label', () => {
    expectTypeOf<SpinnerProps['label']>().toEqualTypeOf<string | undefined>()
  })

  it('is satisfiable with no props (sensible defaults)', () => {
    expectTypeOf<Record<string, never>>().toExtend<SpinnerProps>()
  })
})
