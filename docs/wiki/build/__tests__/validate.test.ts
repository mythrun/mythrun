import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateStructure } from '../validate.ts'
import type { Section } from '../types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const structure: Section[] = [
  { slug: 'infra', title: 'Infra', pages: [{ slug: 'index', title: 'Overview' }] },
]

describe('validateStructure', () => {
  it('returns no errors when content tree matches structure exactly', async () => {
    const result = await validateStructure(structure, resolve(here, 'fixtures/validate/ok'))
    expect(result.errors).toEqual([])
  })

  it('reports a missing content file declared in structure', async () => {
    const result = await validateStructure(
      structure,
      resolve(here, 'fixtures/validate/missing-file'),
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/infra\/index\.html.*missing/i)
  })

  it('reports an orphan content file not declared in structure', async () => {
    const result = await validateStructure(structure, resolve(here, 'fixtures/validate/orphan'))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/runtime\/index\.html.*orphan/i)
  })

  it('catches duplicate section slugs across structure entries', async () => {
    const dupStructure: Section[] = [
      { slug: 'infra', title: 'Infra', pages: [{ slug: 'index', title: 'Overview' }] },
      { slug: 'infra', title: 'Other', pages: [{ slug: 'index', title: 'Overview' }] },
    ]
    const result = await validateStructure(dupStructure, resolve(here, 'fixtures/validate/ok'))
    expect(result.errors.some((e) => /duplicate.*infra/i.test(e))).toBe(true)
  })

  it('catches duplicate page slugs within a section', async () => {
    const dupStructure: Section[] = [
      {
        slug: 'infra',
        title: 'Infra',
        pages: [
          { slug: 'index', title: 'A' },
          { slug: 'index', title: 'B' },
        ],
      },
    ]
    const result = await validateStructure(dupStructure, resolve(here, 'fixtures/validate/ok'))
    expect(result.errors.some((e) => /duplicate.*index.*infra/i.test(e))).toBe(true)
  })

  it('requires the first page of every section to have slug "index"', async () => {
    const badStructure: Section[] = [
      { slug: 'infra', title: 'Infra', pages: [{ slug: 'overview', title: 'Overview' }] },
    ]
    const result = await validateStructure(badStructure, resolve(here, 'fixtures/validate/ok'))
    expect(result.errors.some((e) => /first page.*index/i.test(e))).toBe(true)
  })
})
