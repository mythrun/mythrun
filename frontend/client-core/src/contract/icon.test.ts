import { describe, it, expectTypeOf } from 'vitest'
import type { IconName, IconProps } from './icon.ts'

// Type-level contract for Icon. The runtime barrel is asserted value-free by
// contract.test.ts; here we pin the SHAPE so the native impl satisfies the same
// surface and a typo'd glyph name is a compile error (IconName is a closed union,
// never `string`).
describe('IconProps contract', () => {
  it('exposes a closed IconName union (not string)', () => {
    expectTypeOf<IconName>().toEqualTypeOf<
      | 'close'
      | 'chevron-right'
      | 'chevron-left'
      | 'chevron-down'
      | 'arrow-left'
      | 'arrow-right'
      | 'plus'
      | 'minus'
      | 'check'
      | 'menu'
      | 'search'
      | 'external-link'
      | 'info'
      | 'warning-diamond'
      | 'square-alert'
    >()
  })

  it('requires a typed name', () => {
    expectTypeOf<IconProps>().toHaveProperty('name').toEqualTypeOf<IconName>()
  })

  it('accepts the three token sizes', () => {
    expectTypeOf<IconProps['size']>().toEqualTypeOf<'sm' | 'md' | 'lg' | undefined>()
  })

  it('accepts a labelled icon (accessible name supplied)', () => {
    expectTypeOf<{ name: IconName; label: string }>().toExtend<IconProps>()
  })

  it('accepts a decorative icon (hidden from the a11y tree)', () => {
    expectTypeOf<{ name: IconName; decorative: true }>().toExtend<IconProps>()
  })

  it('accepts a bare icon (defaults to decorative)', () => {
    expectTypeOf<{ name: IconName }>().toExtend<IconProps>()
  })
})
