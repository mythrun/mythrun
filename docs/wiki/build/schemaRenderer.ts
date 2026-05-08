import {
  CLUSTER_ORDER,
  type ClusterName,
  type IndexMeta,
  type SchemaMetadata,
  type TableMeta,
} from './schemaTypes.ts'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`
}

function renderColumnRow(col: TableMeta['columns'][number]): string {
  const nullable = col.nullable ? 'YES' : 'NO'
  const def = col.default === null ? '—' : `<code>${escapeHtml(col.default)}</code>`
  let ref = '—'
  if (col.fk !== null) {
    ref = `<code>${escapeHtml(col.fk.foreignTable)}(${escapeHtml(col.fk.foreignColumn)})</code> ON DELETE ${col.fk.deleteRule}`
  }
  return [
    `      <tr data-column-name="${escapeHtml(col.name)}">`,
    `        <td><code>${escapeHtml(col.name)}</code></td>`,
    `        <td><code>${escapeHtml(col.type)}</code></td>`,
    `        <td>${nullable}</td>`,
    `        <td>${def}</td>`,
    `        <td>${ref}</td>`,
    `      </tr>`,
  ].join('\n')
}

function renderIndex(idx: IndexMeta): string {
  if (idx.expression !== null) {
    // Expression-based index — render the raw indexdef.
    return `    <li><code>${escapeHtml(idx.name)}</code> — <code>${escapeHtml(idx.expression)}</code></li>`
  }
  const uniq = idx.unique ? 'UNIQUE ' : ''
  const cols = `(${idx.columns.join(', ')})`
  const where = idx.predicate === null ? '' : ` WHERE ${escapeHtml(idx.predicate)}`
  return `    <li><code>${escapeHtml(idx.name)}</code> — ${uniq}${escapeHtml(cols)}${where}</li>`
}

function renderTable(table: TableMeta): string {
  const counts: string[] = [
    pluralize(table.columns.length, 'column'),
    pluralize(table.indexes.length, 'index', 'indexes'),
    pluralize(table.checks.length, 'CHECK'),
    pluralize(table.fks.length, 'FK'),
  ]

  const parts: string[] = []
  parts.push(
    `<details class="schema-table" data-table-name="${escapeHtml(table.name)}" id="schema-table-${escapeHtml(table.name)}">`,
  )
  parts.push(`  <summary>`)
  parts.push(`    <span class="schema-table-name">${escapeHtml(table.name)}</span>`)
  parts.push(`    <span class="schema-table-meta">${counts.join(' · ')}</span>`)
  parts.push(`  </summary>`)
  parts.push(`  <table class="schema-columns">`)
  parts.push(
    `    <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>References</th></tr></thead>`,
  )
  parts.push(`    <tbody>`)
  for (const col of table.columns) {
    parts.push(renderColumnRow(col))
  }
  parts.push(`    </tbody>`)
  parts.push(`  </table>`)
  if (table.indexes.length > 0) {
    parts.push(`  <h4>Indexes</h4>`)
    parts.push(`  <ul class="schema-list">`)
    for (const idx of table.indexes) parts.push(renderIndex(idx))
    parts.push(`  </ul>`)
  }
  if (table.checks.length > 0) {
    parts.push(`  <h4>CHECK constraints</h4>`)
    parts.push(`  <ul class="schema-list">`)
    for (const c of table.checks) {
      parts.push(`    <li><code>${escapeHtml(c.clause)}</code></li>`)
    }
    parts.push(`  </ul>`)
  }
  parts.push(`</details>`)
  return parts.join('\n')
}

export function renderSchema(meta: SchemaMetadata): string {
  const byCluster = new Map<ClusterName, TableMeta[]>()
  for (const t of meta.tables) {
    const list = byCluster.get(t.cluster) ?? []
    list.push(t)
    byCluster.set(t.cluster, list)
  }

  const out: string[] = []
  for (const cluster of CLUSTER_ORDER) {
    const tables = byCluster.get(cluster)
    if (tables === undefined || tables.length === 0) continue
    out.push(`<h2 class="schema-cluster">${escapeHtml(cluster)}</h2>`)
    for (const t of tables) {
      out.push(renderTable(t))
    }
  }
  return out.join('\n')
}
