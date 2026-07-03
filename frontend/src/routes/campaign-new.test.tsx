import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { i18n } from '../i18n/config.ts'
import { CampaignNewRoute } from './campaign-new.tsx'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. The screen mounts
// @mythrun/ui's <ThemeProvider>, which reads `localStorage` on mount. Node 25
// ships a non-functional builtin `localStorage` that SHADOWS jsdom's real
// `Storage`; install a functional in-memory one so the stack renders (mirrors
// landing.test.tsx / onboard.test.tsx).
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
})

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderRoute(): void {
  const router = createMemoryRouter(
    [{ path: '/campaigns/new', element: <CampaignNewRoute /> }],
    { initialEntries: ['/campaigns/new'] },
  )
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => { setMatch(); localStorage.clear() })
// Web's vitest config sets no `globals`, so testing-library's auto-cleanup is not
// registered — `cleanup()` must UNMOUNT the prior render (mirrors landing.test).
afterEach(() => { cleanup() })

const ideaTitle = (): string => i18n.t('campaignNew.fork.idea.title')
const loveTitle = (): string => i18n.t('campaignNew.fork.love.title')

describe('CampaignNewRoute', () => {
  it('renders the fork screen with both choices (i18n keys resolved)', () => {
    renderRoute()
    expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    expect(screen.getByTestId('screen-fork')).toBeDefined()
    expect(screen.getByText(ideaTitle())).toBeDefined()
    expect(screen.getByText(loveTitle())).toBeDefined()
    // Back is hidden on the fork (it is the flow's root).
    expect(screen.queryByTestId('campaign-new-back')).toBeNull()
  })

  it('advances to the freeform screen when "Start from an idea" is chosen', () => {
    renderRoute()
    act(() => { screen.getByText(ideaTitle()).click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
  })

  it('advances to the guided screen when "Build from what you love" is chosen', () => {
    renderRoute()
    act(() => { screen.getByText(loveTitle()).click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
  })

  it('the back affordance pops history and returns to the fork', () => {
    renderRoute()
    act(() => { screen.getByText(ideaTitle()).click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    act(() => { screen.getByTestId('campaign-new-back').click() })
    expect(screen.getByTestId('screen-fork')).toBeDefined()
    expect(screen.queryByTestId('campaign-new-back')).toBeNull()
  })
})
