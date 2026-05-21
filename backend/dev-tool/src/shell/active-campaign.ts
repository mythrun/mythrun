// backend/dev-tool/src/shell/active-campaign.ts
//
// myth-mbdc: global single-source-of-truth for the active campaign id.
// Persists to localStorage; notifies subscribers on change.

const STORAGE_KEY = 'devtool.activeCampaignId'
// myth-fn51 P6.C — character-view-panel reads this key to know which
// character to fetch. Roster panel sets it when the operator clicks
// "view" on a row whose conceptStatus === 'completed' AND has a
// characterId. Co-located here so dev-tool readers see the active-X
// keys side-by-side; lifetimes are coupled (clearing the campaign id
// invalidates the character id).
const CHAR_STORAGE_KEY = 'devtool.activeCharacterId'

const subscribers = new Set<(id: string | null) => void>()

export function getActiveCampaignId(): string | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === null || v === '' ? null : v
}

export function setActiveCampaignId(id: string | null): void {
  if (id === null) {
    localStorage.removeItem(STORAGE_KEY)
    // Clearing the active campaign invalidates any cached character
    // pick — a character only exists in the context of its campaign.
    localStorage.removeItem(CHAR_STORAGE_KEY)
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

export function getActiveCharacterId(): string | null {
  const v = localStorage.getItem(CHAR_STORAGE_KEY)
  return v === null || v === '' ? null : v
}

export function setActiveCharacterId(id: string | null): void {
  if (id === null) {
    localStorage.removeItem(CHAR_STORAGE_KEY)
  } else {
    localStorage.setItem(CHAR_STORAGE_KEY, id)
  }
}
