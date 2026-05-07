import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PROMPTS_ROOT = resolve(here, 'prompts')

const cache = new Map<string, string>()

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
 * cache it on first read, and interpolate `{{vars}}` if provided.
 *
 * Throws on missing files. Cache is process-scoped so a deploy starts
 * fresh; subsequent reads of the same `area/name` pair reuse the cached
 * template (the file contents are not re-checked).
 */
export function loadPrompt(
  area: string,
  name: string,
  vars?: Record<string, string>,
): string {
  const key = `${area}/${name}`
  let template = cache.get(key)
  if (template === undefined) {
    const path = resolve(PROMPTS_ROOT, area, `${name}.txt`)
    template = readFileSync(path, 'utf-8')
    cache.set(key, template)
  }
  return interpolate(template, vars ?? {})
}

export function _resetPromptCacheForTests(): void {
  cache.clear()
}
