const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}

const FORBIDDEN_RE = /^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;?\s*$/i

/**
 * Reject top-level transaction-control statements. Dollar-quote-aware:
 * PL/pgSQL bodies (`DO $$ BEGIN ... END $$`, `CREATE FUNCTION ... AS $$ ... $$`)
 * contain literal BEGIN/END and must not be falsely rejected.
 */
export function validateNoTransactionStatements(
  filename: string,
  contents: string,
): void {
  // Strip dollar-quoted runs in place by replacing them with newlines so line
  // numbers are preserved for error messages.
  const stripped = stripDollarQuoted(contents)
  const lines = stripped.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    // Strip line comment.
    const noComment = raw.replace(/--.*$/, '').trim()
    if (noComment === '') continue
    const match = FORBIDDEN_RE.exec(noComment)
    if (match) {
      const token = (match[1] ?? '').toUpperCase()
      const lineNo = String(i + 1)
      throw new Error(
        `migration ${filename} contains forbidden top-level transaction statement '${token}' at line ${lineNo}. ` +
          `The runner wraps each file in BEGIN/COMMIT; nested transaction control is not allowed. ` +
          `Remove the statement or split into a separate file.`,
      )
    }
  }
}

/**
 * Replace each dollar-quoted block with a same-line-count newline run.
 * Tags: $$, $tag$, $custom_tag$ — must match opening to closing tag exactly.
 * Preserves source-line numbering so validator error messages stay useful.
 */
function stripDollarQuoted(input: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    if (input[i] === '$') {
      // Try to match an opening tag: $tag$
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      const fullTag = tagMatch?.[0] // e.g. "$$" or "$body$"
      if (fullTag !== undefined) {
        const closeIdx = input.indexOf(fullTag, i + fullTag.length)
        if (closeIdx >= 0) {
          // Replace the dollar-quoted run with newlines matching the count
          // of newlines inside it, preserving line numbers.
          const inner = input.slice(i, closeIdx + fullTag.length)
          const newlineCount = (inner.match(/\n/g) ?? []).length
          out += '\n'.repeat(newlineCount)
          i = closeIdx + fullTag.length
          continue
        }
      }
    }
    out += input[i] ?? ''
    i++
  }
  return out
}
