// Renders a <select> for the current dev-sub identity. Writes to
// identity.ts on change, which broadcasts the change event.
//
// Pattern: event-driven (the panel never fetches on mount — it only
// responds to the user's select-change). The wrapping element carries
// data-state="idle" so the verify harness can recognize the panel's
// steady post-mount state without conflating it with an in-progress
// fetch panel that hasn't loaded yet.

import { DEV_SUBS, getCurrentDevSub, setCurrentDevSub, type DevSub } from '../identity.js'

export function mountIdentitySwitcher(parent: HTMLElement): void {
  const wrap = document.createElement('div')
  wrap.className = 'identity-switcher'
  wrap.setAttribute('data-state', 'idle')

  const label = document.createElement('label')
  label.textContent = 'Acting as: '

  const select = document.createElement('select')
  const current = getCurrentDevSub()
  for (const sub of DEV_SUBS) {
    const opt = document.createElement('option')
    opt.value = sub
    opt.textContent = sub
    if (sub === current) opt.selected = true
    select.appendChild(opt)
  }
  select.addEventListener('change', () => {
    // Safe: options are populated only from DEV_SUBS above.
    setCurrentDevSub(select.value as DevSub)
  })

  label.appendChild(select)
  wrap.appendChild(label)
  parent.appendChild(wrap)
}
