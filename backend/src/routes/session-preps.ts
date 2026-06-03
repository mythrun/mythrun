// backend/src/routes/session-preps.ts
//
// MYT-63: session-prep CRUD/trigger HTTP routes (trigger / list / read / reset).
// This task (T3) lands the producer queue surface only; the four routes +
// the SafeSessionPrep projection land in T4 below the interface.
//
// Enforced ignorance: the HTTP surface NEVER serves sd_playbook (see
// SafeSessionPrep in T4). The persisted prep row carries ft_context (FT-safe)
// + sd_playbook (Slow-Thinker, may contain secrets); only Session Runtime reads
// sd_playbook in-process via repo.sessionPreps, and the dev-tool inspects it live
// via the MYT-62 prep-prose stream.

// Minimal producer surface for the session-prep BullMQ queue. Declared here
// (not BullMQ's Queue class) so AppDeps + tests inject a hand-rolled spy —
// exactly like WorldGenQueueLike (routes/campaigns.ts).
export interface SessionPrepQueueLike {
  add(
    name: 'session-prep',
    data: { campaignId: string; sessionNumber: number },
    opts?: { jobId?: string },
  ): Promise<unknown>
}
