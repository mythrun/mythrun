import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PROMPTS_ROOT = resolve(here, 'prompts')

const cache = new Map<string, string>()

/**
 * Read `backend/src/llm/prompts/<relPath>.txt`, cached on first read. `relPath`
 * is an `<area>/<name>` pair (e.g. `session/ft-system`, `shared/prose-register`).
 * Cache is process-scoped so a deploy starts fresh.
 */
function readRaw(relPath: string): string {
  let template = cache.get(relPath)
  if (template === undefined) {
    template = readFileSync(resolve(PROMPTS_ROOT, `${relPath}.txt`), 'utf-8')
    cache.set(relPath, template)
  }
  return template
}

const INCLUDE_RE = /\{\{include:([\w./-]+)\}\}/g

/**
 * Resolve `{{include:<area>/<name>}}` directives by splicing in the referenced
 * template's raw text. This is the shared-partial mechanism: a single block file
 * (e.g. `shared/prose-register`) can be composed into many prompts without
 * duplicating its content. Pure, deterministic template composition — no
 * conditionals, no logic, just text substitution.
 *
 * Includes may nest; `stack` carries the include chain so a cycle throws loudly
 * rather than recursing forever. A directive spliced twice at sibling positions
 * (a diamond) is fine — each branch gets its own chain.
 *
 * Exported so prep stages that read their template via `readFileSync` (rather
 * than `loadPrompt`) can resolve includes the same way at module load.
 */
export function resolveIncludes(text: string, stack: readonly string[] = []): string {
  return text.replace(INCLUDE_RE, (_match: string, relPath: string) => {
    if (stack.includes(relPath)) {
      throw new Error(`prompt include cycle: ${[...stack, relPath].join(' -> ')}`)
    }
    return resolveIncludes(readRaw(relPath), [...stack, relPath])
  })
}

/**
 * Replace `{{var}}` occurrences in `template` with values from `vars`.
 * Unmatched placeholders are left as-is so a missing variable surfaces
 * visibly in the rendered output (and on inspection of the LLM call).
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match
    return vars[key] ?? match
  })
}

/**
 * Load a prompt template from `backend/src/llm/prompts/<area>/<name>.txt`,
 * resolve any `{{include:…}}` partials, cache the raw read on first access,
 * and interpolate `{{vars}}` if provided.
 *
 * Throws on missing files. Cache is process-scoped so a deploy starts
 * fresh; subsequent reads of the same `area/name` pair reuse the cached
 * template (the file contents are not re-checked).
 */
export function loadPrompt(area: string, name: string, vars?: Record<string, string>): string {
  return interpolate(resolveIncludes(readRaw(`${area}/${name}`)), vars ?? {})
}

export function _resetPromptCacheForTests(): void {
  cache.clear()
}
