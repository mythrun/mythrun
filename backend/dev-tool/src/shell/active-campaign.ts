// backend/dev-tool/src/shell/active-campaign.ts
//
// myth-mbdc: global single-source-of-truth for the active campaign id.
// Persists to localStorage; notifies subscribers on change.

const STORAGE_KEY = 'devtool.activeCampaignId'

const subscribers = new Set<(id: string | null) => void>()

export function getActiveCampaignId(): string | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === null || v === '' ? null : v
}

export function setActiveCampaignId(id: string | null): void {
  if (id === null) {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, id)
  }
  for (const cb of subscribers) {
    cb(id)
  }
}

export function onActiveCampaignChanged(cb: (id: string | null) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
