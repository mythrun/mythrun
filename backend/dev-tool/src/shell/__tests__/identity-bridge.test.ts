// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { installIdentityBridge } from '../identity-bridge.js'

describe('installIdentityBridge', () => {
  it('fires onIdentityChange when mythrun.identitychanged dispatches', () => {
    const onIdentityChange = vi.fn()
    const dispose = installIdentityBridge({ onIdentityChange })
    window.dispatchEvent(new CustomEvent<string>('mythrun.identitychanged', { detail: 'dev-user-2' }))
    expect(onIdentityChange).toHaveBeenCalledWith('dev-user-2')
    dispose()
  })

  it('dispose removes the listener', () => {
    const onIdentityChange = vi.fn()
    const dispose = installIdentityBridge({ onIdentityChange })
    dispose()
    window.dispatchEvent(new CustomEvent<string>('mythrun.identitychanged', { detail: 'dev-user-2' }))
    expect(onIdentityChange).not.toHaveBeenCalled()
  })
})
