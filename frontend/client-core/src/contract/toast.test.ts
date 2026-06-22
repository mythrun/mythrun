import { describe, it, expectTypeOf } from 'vitest'
import type { ToastOptions, ToastProviderProps, Severity } from './index.ts'

// Type-level contract for the Toast subsystem. The imperative `toast()` function
// is a RUNTIME value and ships from the UI package (not this type-only barrel);
// here we pin the OPTIONS + PROVIDER shape so the native impl matches.
describe('Toast contract', () => {
  it('requires a title and accepts an optional severity / description / duration', () => {
    expectTypeOf<ToastOptions>().toHaveProperty('title').toEqualTypeOf<string>()
    expectTypeOf<ToastOptions['severity']>().toEqualTypeOf<Severity | undefined>()
    expectTypeOf<ToastOptions['description']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ToastOptions['duration']>().toEqualTypeOf<number | undefined>()
  })

  it('accepts the minimal title-only toast', () => {
    expectTypeOf<{ title: string }>().toExtend<ToastOptions>()
  })

  it('exposes a provider with subsystem-tuning props (closeLabel / maxVisible / defaultDuration)', () => {
    expectTypeOf<ToastProviderProps['closeLabel']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ToastProviderProps['maxVisible']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<ToastProviderProps['defaultDuration']>().toEqualTypeOf<number | undefined>()
  })
})
