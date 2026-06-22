import { describe, it, expect } from 'vitest'
import { cn } from './cn.ts'

describe('cn', () => {
  it('merges conflicting tailwind classes (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })
  it('drops falsy and joins', () => {
    expect(cn('a', false, 'c')).toBe('a c')
  })
})
