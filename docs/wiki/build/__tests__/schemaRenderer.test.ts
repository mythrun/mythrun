import { describe, it, expect } from 'vitest'
import { renderSchema } from '../schemaRenderer.ts'
import { minimalMetadata } from './fixtures/schemaRenderer/minimal-metadata.ts'

describe('renderSchema', () => {
  const html = renderSchema(minimalMetadata)

  it('emits one <h2> per non-empty cluster, in display order', () => {
    const h2s = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(h2s).toEqual([
      'Identity &amp; billing',
      'Worlds &amp; entities',
      'Campaigns &amp; play',
      'Pipeline &amp; ops',
      'SRD reference',
    ])
  })

  it('emits one <details data-table-name="X"> per table', () => {
    for (const name of ['users', 'facts', 'sessions', 'pipeline_runs', 'srd_monsters']) {
      expect(html).toContain(`data-table-name="${name}"`)
    }
  })

  it('emits one <tr data-column-name="X"> per column', () => {
    expect(html).toMatch(/data-column-name="email"/)
    expect(html).toMatch(/data-column-name="entity_id"/)
    expect(html).toMatch(/data-column-name="access_level"/)
  })

  it('renders FK references inline in the columns table', () => {
    expect(html).toMatch(/entities\(id\)<\/code>\s*ON DELETE CASCADE/)
  })

  it('omits the Indexes section when a table has no indexes', () => {
    // srd_monsters has no indexes; the <details> for it must not contain "<h4>Indexes</h4>".
    // Find the srd_monsters block and assert.
    const srdStart = html.indexOf('data-table-name="srd_monsters"')
    const srdEnd = html.indexOf('</details>', srdStart)
    const srdBlock = html.slice(srdStart, srdEnd)
    expect(srdBlock).not.toContain('Indexes')
    expect(srdBlock).not.toContain('CHECK constraints')
  })

  it('renders the partial-index predicate', () => {
    expect(html).toContain("WHERE status = 'active'::text")
  })

  it('falls back to raw indexdef for expression-based indexes', () => {
    // pipeline_runs idx_pipeline_runs_unique has columns=[] expression=raw.
    expect(html).toContain('idx_pipeline_runs_unique')
    expect(html).toContain("COALESCE(world_id, campaign_id)")
  })

  it('renders CHECK constraint clauses verbatim', () => {
    expect(html).toContain(
      "CHECK ((access_level = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text])))",
    )
  })

  it('escapes HTML special characters in identifiers', () => {
    const evil: import('../schemaTypes.ts').SchemaMetadata = {
      tables: [
        {
          name: 't<x>',
          cluster: 'Other',
          columns: [{ name: 'c"y', type: 'text', nullable: false, default: null, fk: null }],
          indexes: [],
          checks: [],
          fks: [],
        },
      ],
    }
    const out = renderSchema(evil)
    expect(out).toContain('t&lt;x&gt;')
    expect(out).toContain('c&quot;y')
    expect(out).not.toContain('<x>')
  })

  it('formats the column-row meta summary with counts', () => {
    // facts: 3 columns, 1 index, 1 CHECK, 1 FK — the summary should show those counts.
    const factsStart = html.indexOf('data-table-name="facts"')
    const factsEnd = html.indexOf('</summary>', factsStart)
    const summary = html.slice(factsStart, factsEnd)
    expect(summary).toContain('3 columns')
    expect(summary).toContain('1 index')
    expect(summary).toContain('1 CHECK')
    expect(summary).toContain('1 FK')
  })

  it('produces no output for an empty cluster', () => {
    const empty: import('../schemaTypes.ts').SchemaMetadata = { tables: [] }
    const out = renderSchema(empty)
    // No <h2> headers; the wrapper is allowed to be empty.
    expect(out).not.toMatch(/<h2/)
  })
})
