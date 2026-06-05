// backend/src/contract/session-channel.ts
//
// The single source of truth for the multiplayer session pub/sub channel
// format. SessionHub (sse/ws fan-out) PSUBSCRIBEs the pattern and the turn
// worker — a DIFFERENT process — publishes to the per-campaign channel. A
// re-derived channel string that drifts from this would silently fan out to
// nobody, so both sides must derive it here.
//
// Format: `{keyPrefix}session:campaign:{campaignId}`. The keyPrefix is the
// Redis namespace (e.g. `staging:use1:`) and CONTAINS COLONS — channel-key
// extraction is suffix-slice, never split-on-':'.

const SUFFIX = 'session:campaign:'

/** The per-campaign pub/sub channel a turn is published to / fanned out from. */
export function sessionChannel(keyPrefix: string, campaignId: string): string {
  return `${keyPrefix}${SUFFIX}${campaignId}`
}

/** The PSUBSCRIBE glob that matches every campaign's session channel. */
export function sessionChannelPattern(keyPrefix: string): string {
  return `${keyPrefix}${SUFFIX}*`
}

/** Suffix-slice — the prefix contains colons, so never split on ':'. */
export function campaignIdFromChannel(keyPrefix: string, channel: string): string {
  return channel.slice(`${keyPrefix}${SUFFIX}`.length)
}
