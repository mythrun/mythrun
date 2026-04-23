export interface TocEntry {
  level: 2 | 3
  id: string
  text: string
}

export interface ExtractTocResult {
  entries: TocEntry[]
  html: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const headingRegex = /<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g
const idAttrRegex = /\sid="([^"]+)"/

export function extractToc(fragment: string): ExtractTocResult {
  const entries: TocEntry[] = []
  const seen = new Map<string, number>()

  const html = fragment.replace(
    headingRegex,
    (match, levelStr: string, attrs: string | undefined, inner: string) => {
      const level = Number(levelStr) as 2 | 3
      const text = inner.replace(/<[^>]+>/g, '').trim()
      const attrString = attrs ?? ''
      const existingId = idAttrRegex.exec(attrString)?.[1]

      let id: string
      if (existingId !== undefined) {
        id = existingId
        // Reserve the user-declared id so a later auto-slug that collides with
        // it disambiguates rather than emitting a duplicate DOM id.
        seen.set(id, (seen.get(id) ?? 0) + 1)
      } else {
        const base = slugify(text) || `heading-${String(entries.length + 1)}`
        const count = seen.get(base) ?? 0
        id = count === 0 ? base : `${base}-${String(count + 1)}`
        seen.set(base, count + 1)
      }

      entries.push({ level, id, text })

      if (existingId !== undefined) {
        return match
      }
      return `<h${levelStr}${attrString} id="${id}">${inner}</h${levelStr}>`
    },
  )

  return { entries, html }
}
