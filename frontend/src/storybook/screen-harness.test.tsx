import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { useSessionStore, type BalanceResponse, type CampaignSummary } from '@mythrun/client-core'
import { ScreenHarness } from './screen-harness.tsx'

// The ScreenHarness pre-seeds the suspense caches the screen tree reads so a
// story renders without firing a network call (a key/shape mismatch would
// suspend-hang forever). T13 adds `seedBalance` alongside `seedCampaigns` for
// the header-credits `useBalance` query. There is no balance-reading route yet
// (the header wiring is a downstream ticket), so this test gates the part T13
// owns: the new optional prop is accepted (type) and feeding it does NOT break
// the composed render path — the real /home tree still mounts behind the
// pre-seeded `['campaigns','mine']` cache. The deeper "a balance reader reads
// the seed" guarantee is exercised by the hub story once a consumer exists,
// exactly as `seedCampaigns` is exercised by the home story today.
//
// localStorage shim mirrors the home.test.tsx precedent: Node ships a
// non-functional builtin Storage that shadows jsdom's, and the rendered shell
// (ThemeProvider) reads it on mount.
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
afterEach(() => {
  act(() => {
    useSessionStore.getState().setUnauthenticated()
  })
})

const campaign: CampaignSummary = {
  id: 'c-1',
  worldId: 'w-1',
  name: 'The Sunken Coast',
  status: 'active',
  language: 'en',
  createdAt: '2026-06-24T10:00:00.000Z',
  updatedAt: '2026-06-24T11:00:00.000Z',
  worldName: 'The Sunken Coast',
  worldColors: null,
  creator: null,
  party: [{ userId: 'dev-user-1', displayName: 'Pilot', hasCharacter: true }],
  sessionCount: 0,
  lastPlayedAt: null,
  cardPhase: 'not-played',
}

const balance: BalanceResponse = {
  session: 3,
  world_gen: 1,
  active_subscription: null,
}

describe('ScreenHarness seedBalance', () => {
  it('renders the seeded screen tree with seedBalance present', async () => {
    render(<ScreenHarness entry="/home" seedCampaigns={[campaign]} seedBalance={balance} />)

    // The composed /home tree mounts (app-frame + the seeded campaign) with the
    // new balance seed in the cache — no suspend-hang, no thrown render.
    await waitFor(() => {
      expect(screen.getByTestId('app-frame')).toBeDefined()
    })
    expect(screen.getByText(campaign.name)).toBeDefined()
  })
})
