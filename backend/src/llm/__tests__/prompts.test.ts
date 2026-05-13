import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { loadPrompt, _resetPromptCacheForTests } from '../prompts.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsDir = resolve(here, '..', 'prompts')

describe('loadPrompt', () => {
  beforeEach(() => {
    _resetPromptCacheForTests()
    mkdirSync(resolve(promptsDir, 'auth'), { recursive: true })
  })

  it('reads a template file and returns it', () => {
    const path = resolve(promptsDir, 'auth', 'test_simple.txt')
    writeFileSync(path, 'hello world')
    try {
      expect(loadPrompt('auth', 'test_simple')).toBe('hello world')
    } finally {
      rmSync(path)
    }
  })

  it('interpolates {{variable}} placeholders', () => {
    const path = resolve(promptsDir, 'auth', 'test_interp.txt')
    writeFileSync(path, 'Hello {{name}}, welcome to {{app}}!')
    try {
      expect(loadPrompt('auth', 'test_interp', { name: 'Miklos', app: 'Mythrun' })).toBe(
        'Hello Miklos, welcome to Mythrun!',
      )
    } finally {
      rmSync(path)
    }
  })

  it('caches the template — second call does not re-read', () => {
    const path = resolve(promptsDir, 'auth', 'test_cache.txt')
    writeFileSync(path, 'first read')
    try {
      const first = loadPrompt('auth', 'test_cache')
      writeFileSync(path, 'second read')
      const second = loadPrompt('auth', 'test_cache')
      expect(first).toBe(second)
      expect(second).toBe('first read')
    } finally {
      rmSync(path)
    }
  })

  it('throws on missing file', () => {
    expect(() => loadPrompt('auth', 'does_not_exist')).toThrow()
  })

  it('handles undefined vars (no interpolation)', () => {
    const path = resolve(promptsDir, 'auth', 'test_noargs.txt')
    writeFileSync(path, 'no placeholders here')
    try {
      expect(loadPrompt('auth', 'test_noargs')).toBe('no placeholders here')
    } finally {
      rmSync(path)
    }
  })

  it('leaves unmatched {{placeholders}} alone if vars do not include them', () => {
    const path = resolve(promptsDir, 'auth', 'test_unmatched.txt')
    writeFileSync(path, 'Has {{a}} and {{b}}')
    try {
      expect(loadPrompt('auth', 'test_unmatched', { a: 'X' })).toBe('Has X and {{b}}')
    } finally {
      rmSync(path)
    }
  })

  it('preserves placeholder when key is present but value is undefined', () => {
    // Exercises the `vars[key] ?? match` branch — hasOwnProperty short-
    // circuit returns false for missing keys, but here the key IS present
    // with value `undefined`, so we fall through to the `??` fallback.
    const path = resolve(promptsDir, 'auth', 'test_undefined_value.txt')
    writeFileSync(path, 'Hello {{name}}!')
    try {
      // TS-ish: a Record<string, string> normally can't hold undefined,
      // but the runtime guard exists for this exact case. Cast via unknown.
      const vars = { name: undefined as unknown as string }
      expect(loadPrompt('auth', 'test_undefined_value', vars)).toBe('Hello {{name}}!')
    } finally {
      rmSync(path)
    }
  })
})
