import type { CampaignSummary } from '@mythrun/client-core'

// The campaign-hub order (MYT-bapkt). The dashboard's top job is "continue where
// you left off," so cards sort by most-recent ACTIVITY first: a campaign's activity
// time is when it was last played, falling back to when it was last touched
// (`updatedAt`) for one not yet played. This also kills the run-1 defect where
// not-started campaigns sat first (ahead of active ones) in an arbitrary order.
//
// Pure + stable: returns a NEW array (never mutates the query cache's data) and, for
// equal activity times, preserves input order — so the sort is deterministic across
// engines and re-renders.
export function sortCampaignsForHub(campaigns: readonly CampaignSummary[]): CampaignSummary[] {
  const activityMs = (c: CampaignSummary): number => new Date(c.lastPlayedAt ?? c.updatedAt).getTime()
  // Decorate → sort → undecorate: parse each date once, and carry the original
  // index as the stable tiebreaker.
  return campaigns
    .map((campaign, index) => ({ campaign, index, at: activityMs(campaign) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.campaign)
}
