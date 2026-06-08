import { describe, it, expect } from 'vitest'
import { loadPrompt, _resetPromptCacheForTests } from '../../prompts.js'

describe('dm-trigger-classifier prompt', () => {
  it('loads and states the three-way decision + the confidence anchor + the public-only boundary', () => {
    _resetPromptCacheForTests?.()
    const p = loadPrompt('session', 'dm-trigger-classifier')
    expect(p.toLowerCase()).toContain('respond')
    expect(p.toLowerCase()).toContain('sit back')
    expect(p.toLowerCase()).toContain('step in')
    expect(p).toContain('0.8')
    expect(p.toLowerCase()).toContain('secret')
  })
})
