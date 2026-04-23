import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Section } from './types.ts'

export interface ValidateResult {
  errors: string[]
}

async function enumerateHtmlFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested: string[][] = await Promise.all(
    entries.map(async (entry) => {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) return enumerateHtmlFiles(abs, base)
      if (entry.isFile() && entry.name.endsWith('.html')) {
        return [relative(base, abs)]
      }
      return []
    }),
  )
  return nested.flat().sort()
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

export async function validateStructure(
  structure: Section[],
  contentDir: string,
): Promise<ValidateResult> {
  const errors: string[] = []

  const seenSectionSlugs = new Set<string>()
  for (const section of structure) {
    if (seenSectionSlugs.has(section.slug)) {
      errors.push(`duplicate section slug "${section.slug}" in structure`)
    }
    seenSectionSlugs.add(section.slug)

    if (section.pages[0].slug !== 'index') {
      errors.push(`first page of section "${section.slug}" must have slug "index"`)
    }

    const seenPageSlugs = new Set<string>()
    for (const page of section.pages) {
      if (seenPageSlugs.has(page.slug)) {
        errors.push(`duplicate page slug "${page.slug}" in section "${section.slug}"`)
      }
      seenPageSlugs.add(page.slug)
    }
  }

  const declared = new Set<string>()
  declared.add('index.html')
  for (const section of structure) {
    for (const page of section.pages) {
      declared.add(`${section.slug}/${page.slug}.html`)
    }
  }

  const actual = new Set(await enumerateHtmlFiles(contentDir))

  for (const relPath of declared) {
    if (!actual.has(relPath)) {
      const exists = await fileExists(join(contentDir, relPath))
      if (!exists) {
        errors.push(`content file ${relPath} is missing (declared in structure)`)
      }
    }
  }

  for (const relPath of actual) {
    if (!declared.has(relPath)) {
      errors.push(`content file ${relPath} is orphan (not in structure)`)
    }
  }

  return { errors }
}
