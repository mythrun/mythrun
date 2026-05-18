// @vitest-environment jsdom
//
// myth-pfke T12 — DOM tests for renderGlossarySection. Runs under the
// jsdom vitest environment (jsdom is in backend devDependencies; the
// `@vitest-environment` pragma above scopes it to this file so the rest
// of the suite keeps using the default node environment).
//
// The XSS-safety test is load-bearing: the renderer MUST use textContent,
// never innerHTML, so server-returned strings flow through the DOM as
// literal text. Replacing textContent with innerHTML would silently break
// this contract and pass typecheck.

import { describe, expect, it, beforeEach } from 'vitest'
import { renderGlossarySection } from '../world-snapshot-render.js'
import type { VocabularyRegistry } from '../world-snapshot-types.js'

describe('renderGlossarySection', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
  })

  it('renders empty-state when registry has no entries and no franchises', () => {
    const registry: VocabularyRegistry = { entries: [], adjacent_franchises: [] }
    renderGlossarySection(container, registry)
    expect(container.textContent).toContain('No vocabulary registered')
  })

  it('renders the adjacent franchises subheader when present', () => {
    const registry: VocabularyRegistry = {
      entries: [],
      adjacent_franchises: ['Harry Potter', 'Diagon Alley'],
    }
    renderGlossarySection(container, registry)
    expect(container.textContent).toContain('Adjacent franchises: Harry Potter, Diagon Alley')
  })

  it('renders entries grouped by source', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'A',
          definition: 'a long enough definition to satisfy the schema bound.',
          source: 'stage_1_5',
          access_level: 'known',
        },
        {
          term: 'B',
          definition: 'another long enough definition to satisfy the schema bound.',
          source: 'consolidation',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    renderGlossarySection(container, registry)
    expect(container.textContent).toContain('From world creation')
    expect(container.textContent).toContain('From consolidation')
    expect(container.textContent).toContain('A')
    expect(container.textContent).toContain('B')
  })

  it('renders term + definition pairs in a <dl>', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition: "non-magical people; this world's term for those without arcane sight.",
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    renderGlossarySection(container, registry)
    const dt = container.querySelector('dt')
    const dd = container.querySelector('dd')
    expect(dt?.textContent).toBe('the unwitched')
    expect(dd?.textContent).toContain('non-magical people')
    expect(dd?.textContent).toContain('use instead of "muggle"')
  })

  it('uses textContent for definitions (no innerHTML injection)', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 't',
          definition: '<script>alert(1)</script>This is a fake XSS payload longer than 30 chars.',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    renderGlossarySection(container, registry)
    // The <script> tag must appear as literal text, NOT as a DOM element.
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})
