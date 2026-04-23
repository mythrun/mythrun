import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { join, dirname, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Section } from './types.ts'
import { computeSourceHash } from './sourceHash.ts'
import { extractToc } from './extractToc.ts'
import { renderDot } from './renderDot.ts'
import { renderShell } from './renderShell.ts'
import { validateStructure } from './validate.ts'
import { parsePageMeta, checkDrift, renderDriftBanner, rewriteSourceHash } from './drift.ts'
import { extractRunbookEntries, type RunbookEntry } from './extractRunbooks.ts'

export type BuildMode = 'build' | 'check' | 'accept-drift'

export interface BuildOptions {
  root: string
  structure: Section[]
  mode: BuildMode
  /** Defaults to resolve(root, '..', '..'). Tests can override. */
  repoRoot?: string
}

export interface BuildResult {
  errors: string[]
  warnings: string[]
  exitCode: number
  pagesRendered: number
  diagramsRendered: number
}

interface Page {
  section: Section | null
  pageSlug: string
  pageTitle: string
  contentAbs: string
  outRel: string
  depth: number
}

function collectPages(root: string, structure: Section[]): Page[] {
  const pages: Page[] = []
  pages.push({
    section: null,
    pageSlug: 'index',
    pageTitle: 'Home',
    contentAbs: join(root, 'content/index.html'),
    outRel: 'index.html',
    depth: 0,
  })
  for (const section of structure) {
    for (const page of section.pages) {
      pages.push({
        section,
        pageSlug: page.slug,
        pageTitle: page.title,
        contentAbs: join(root, 'content', section.slug, `${page.slug}.html`),
        outRel: `${section.slug}/${page.slug}.html`,
        depth: 1,
      })
    }
  }
  return pages
}

function renderTopnav(
  structure: Section[],
  currentSectionSlug: string | null,
  rootPath: string,
): string {
  return structure
    .map((s) => {
      const active = s.slug === currentSectionSlug ? ' class="active"' : ''
      return `<a href="${rootPath}${s.slug}/index.html"${active}>${s.title}</a>`
    })
    .join('')
}

function renderSidebar(
  structure: Section[],
  currentSectionSlug: string | null,
  currentPageSlug: string,
  rootPath: string,
): string {
  if (currentSectionSlug === null) return ''
  const section = structure.find((s) => s.slug === currentSectionSlug)
  if (section === undefined) return ''
  const lis = section.pages
    .map((p) => {
      const active = p.slug === currentPageSlug ? ' class="active"' : ''
      return `<li><a href="${rootPath}${section.slug}/${p.slug}.html"${active}>${p.title}</a></li>`
    })
    .join('')
  return `<ul>${lis}</ul>`
}

function renderToc(entries: { level: 2 | 3; id: string; text: string }[]): string {
  if (entries.length === 0) {
    return '<p class="wiki-toc-empty" style="font-size:11px;color:var(--paper-500);">—</p>'
  }
  const lis = entries
    .map(
      (e) =>
        `<li style="padding-left:${e.level === 3 ? '12px' : '0'}"><a href="#${e.id}">${e.text}</a></li>`,
    )
    .join('')
  return `<ul>${lis}</ul>`
}

function renderCrumbs(
  sectionTitle: string | null,
  pageTitle: string,
  pageSlug: string,
  rootPath: string,
): string {
  if (sectionTitle === null) return ''
  if (pageSlug === 'index') {
    return `<a href="${rootPath}index.html">Wiki</a> › ${sectionTitle}`
  }
  return `<a href="${rootPath}index.html">Wiki</a> › ${sectionTitle} › ${pageTitle}`
}

async function resolveDiagrams(
  content: string,
  root: string,
  header: string,
): Promise<{ html: string; count: number }> {
  const re = /<!--\s*@diagram:\s*([^\s][^\s]*?)\s*-->/g
  const matches = [...content.matchAll(re)]
  if (matches.length === 0) return { html: content, count: 0 }

  let count = 0
  let result = content
  for (const match of matches) {
    const id = match[1]
    if (id === undefined) continue
    const dotPath = join(root, 'diagrams', `${id}.dot`)
    const dotSource = await readFile(dotPath, 'utf-8')
    const svg = await renderDot(dotSource, header)
    result = result.replace(match[0], svg)
    count += 1
  }
  return { html: result, count }
}

function filterSlots(
  allSlots: Record<string, string>,
  declared: Set<string>,
): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const name of declared) {
    filtered[name] = allSlots[name] ?? ''
  }
  return filtered
}

function collectShellSlotNames(shell: string): Set<string> {
  const names = new Set<string>()
  const re = /<!--\s*@(\w+)\s*-->/g
  for (let m = re.exec(shell); m !== null; m = re.exec(shell)) {
    const name = m[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

function buildSlots(
  page: Page,
  structure: Section[],
  contentHtml: string,
  tocHtml: string,
): Record<string, string> {
  const rootPath = page.depth === 0 ? '' : '../'
  const sectionSlug = page.section?.slug ?? ''
  const sectionTitle = page.section?.title ?? null
  const activeSection = sectionSlug === '' ? null : sectionSlug
  return {
    pageTitle: page.pageTitle,
    rootPath,
    sectionSlug,
    pageSlug: page.pageSlug,
    topnav: renderTopnav(structure, activeSection, rootPath),
    sidebar: renderSidebar(structure, activeSection, page.pageSlug, rootPath),
    crumbs: renderCrumbs(sectionTitle, page.pageTitle, page.pageSlug, rootPath),
    content: contentHtml,
    toc: tocHtml,
    lastUpdated: '',
  }
}

function stripMetaComments(content: string): string {
  return content
    .replace(/<!--\s*source:[^\n]*-->\n?/g, '')
    .replace(/<!--\s*source-hash:[^\n]*-->\n?/g, '')
    .replace(/<!--\s*last-ticket:[^\n]*-->\n?/g, '')
}

interface PageOutcome {
  diagramsRendered: number
  /** Error string if mode=check and this page drifted. */
  checkError: string | null
  /** Warning string if drift was observed (build or accept-drift). */
  warning: string | null
}

interface RunbookAggregateItem {
  pageOutRel: string
  sectionTitle: string
  pageTitle: string
  entries: RunbookEntry[]
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function scanAllRunbooks(pages: Page[]): Promise<RunbookAggregateItem[]> {
  const aggregate: RunbookAggregateItem[] = []
  for (const page of pages) {
    const raw = await readFile(page.contentAbs, 'utf-8')
    const stripped = stripMetaComments(raw)
    const toc = extractToc(stripped)
    const entries = extractRunbookEntries(toc.entries)
    if (entries.length > 0) {
      aggregate.push({
        pageOutRel: page.outRel,
        sectionTitle: page.section?.title ?? '',
        pageTitle: page.pageTitle,
        entries,
      })
    }
  }
  return aggregate
}

function renderRunbookIndex(aggregate: RunbookAggregateItem[], rootPath: string): string {
  const flat = aggregate.flatMap((a) =>
    a.entries.map((e) => ({
      title: e.title,
      href: `${rootPath}${a.pageOutRel}#${e.id}`,
      home: a.pageTitle === 'Overview' ? a.sectionTitle : `${a.sectionTitle} → ${a.pageTitle}`,
    })),
  )
  flat.sort((x, y) => x.title.localeCompare(y.title))
  if (flat.length === 0) {
    return '<p class="wiki-runbook-empty" style="color:var(--paper-500)">No runbooks yet — they appear here as operational procedures ship on architectural pages.</p>'
  }
  const lis = flat
    .map(
      (f) =>
        `<li><a href="${f.href}">${escapeHtml(f.title)}</a><span class="wiki-runbook-home">${escapeHtml(f.home)}</span></li>`,
    )
    .join('\n  ')
  return `<ul class="wiki-runbook-index">\n  ${lis}\n</ul>`
}

function resolveRunbookIndex(
  content: string,
  aggregate: RunbookAggregateItem[],
  rootPath: string,
): string {
  if (!content.includes('<!-- @runbooks-index -->')) return content
  return content.replace(/<!--\s*@runbooks-index\s*-->/g, renderRunbookIndex(aggregate, rootPath))
}

interface DriftOutcome {
  warning: string | null
  checkError: string | null
  banner: string
}

async function handleDrift(
  page: Page,
  rawContent: string,
  meta: ReturnType<typeof parsePageMeta>,
  currentHash: string | null,
  ctx: { root: string; mode: BuildMode },
): Promise<DriftOutcome> {
  const drift = checkDrift(meta, currentHash)
  let warning: string | null = null
  let checkError: string | null = null
  if (ctx.mode === 'accept-drift' && drift.drifted && currentHash !== null) {
    const updated = rewriteSourceHash(rawContent, currentHash)
    await writeFile(page.contentAbs, updated)
    warning = `accepted drift: ${relative(ctx.root, page.contentAbs)}`
  } else if (ctx.mode === 'check' && drift.drifted) {
    checkError = `drift: ${relative(ctx.root, page.contentAbs)} (${drift.status})`
  } else if (ctx.mode === 'build' && drift.drifted) {
    warning = `drift warning: ${relative(ctx.root, page.contentAbs)} (${drift.status})`
  }
  const banner =
    drift.drifted && ctx.mode !== 'accept-drift' ? renderDriftBanner(meta.sourcePaths) + '\n' : ''
  return { warning, checkError, banner }
}

async function renderPage(
  page: Page,
  ctx: {
    root: string
    repoRoot: string
    structure: Section[]
    mode: BuildMode
    shell: string
    dotHeader: string
    shellSlotNames: Set<string>
    siteDir: string
    runbookAggregate: RunbookAggregateItem[]
  },
): Promise<PageOutcome> {
  const rawContent = await readFile(page.contentAbs, 'utf-8')
  const meta = parsePageMeta(rawContent)

  let currentHash: string | null = null
  if (meta.sourcePaths.length > 0) {
    currentHash = 'sha256:' + (await computeSourceHash(meta.sourcePaths, ctx.repoRoot))
  }

  const { warning, checkError, banner } = await handleDrift(
    page,
    rawContent,
    meta,
    currentHash,
    ctx,
  )

  const rootPath = page.depth === 0 ? '' : '../'
  const withRunbookIndex = resolveRunbookIndex(
    stripMetaComments(rawContent),
    ctx.runbookAggregate,
    rootPath,
  )
  const diagrams = await resolveDiagrams(withRunbookIndex, ctx.root, ctx.dotHeader)
  const withToc = extractToc(diagrams.html)

  const slots = filterSlots(
    buildSlots(page, ctx.structure, banner + withToc.html, renderToc(withToc.entries)),
    ctx.shellSlotNames,
  )
  const html = renderShell(ctx.shell, slots)
  const outAbs = join(ctx.siteDir, page.outRel)
  await mkdir(dirname(outAbs), { recursive: true })
  await writeFile(outAbs, html)

  return { diagramsRendered: diagrams.count, checkError, warning }
}

async function copyStatics(root: string, siteDir: string): Promise<void> {
  if (existsSync(join(root, 'layout/styles.css'))) {
    await cp(join(root, 'layout/styles.css'), join(siteDir, 'styles.css'))
  }
  if (existsSync(join(root, 'layout/helper.js'))) {
    await cp(join(root, 'layout/helper.js'), join(siteDir, 'helper.js'))
  }
  if (existsSync(join(root, 'assets'))) {
    await cp(join(root, 'assets'), join(siteDir, 'assets'), { recursive: true })
  }
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const { root, structure, mode } = options
  const repoRoot = options.repoRoot ?? resolve(root, '..', '..')
  const errors: string[] = []
  const warnings: string[] = []
  const siteDir = join(root, 'site')

  const validation = await validateStructure(structure, join(root, 'content'))
  errors.push(...validation.errors)
  if (errors.length > 0) {
    return { errors, warnings, exitCode: 1, pagesRendered: 0, diagramsRendered: 0 }
  }

  const shell = await readFile(join(root, 'layout/shell.html'), 'utf-8')
  const dotHeader = await readFile(join(root, 'layout/dot-header.dot'), 'utf-8').catch(() => '')
  const shellSlotNames = collectShellSlotNames(shell)

  if (existsSync(siteDir)) await rm(siteDir, { recursive: true, force: true })
  await mkdir(siteDir, { recursive: true })

  const pages = collectPages(root, structure)
  // Scan all pages for runbook entries before rendering, so the Runbooks
  // index page gets the full aggregated list regardless of iteration order.
  const runbookAggregate = await scanAllRunbooks(pages)
  let diagramsRendered = 0
  let strictFailures = 0
  const ctx = {
    root,
    repoRoot,
    structure,
    mode,
    shell,
    dotHeader,
    shellSlotNames,
    siteDir,
    runbookAggregate,
  }

  for (const page of pages) {
    const outcome = await renderPage(page, ctx)
    diagramsRendered += outcome.diagramsRendered
    if (outcome.warning !== null) warnings.push(outcome.warning)
    if (outcome.checkError !== null) {
      errors.push(outcome.checkError)
      strictFailures += 1
    }
  }

  await copyStatics(root, siteDir)

  const exitCode = mode === 'check' && strictFailures > 0 ? 1 : errors.length > 0 ? 1 : 0
  return { errors, warnings, exitCode, pagesRendered: pages.length, diagramsRendered }
}
