// The world-gen ENTITY FLOOR (MYT-89 fog spawn-drain) — the denominator the fog's
// clear is keyed to. Miklos's spec: the fog clears in proportion to the number of
// ENTITIES that have streamed in (not stage progress), and must be entirely gone by
// the time a generation hits the minimum entity count a real world produces. This is
// a PRODUCT constant derived from production-shaped data — it is deliberately NOT in
// `fog-params.ts` (that module is the verbatim reference-prototype port; nothing in
// it may be re-derived).

/**
 * The minimum entity count a completed world generation is expected to produce —
 * the fog-drain denominator: the generating view feeds `nodes.length /
 * MIN_EXPECTED_ENTITIES` into the fog as its spawn scale (`1 − shown/min`, clamped),
 * so the fog's respawn flux ramps to ZERO by the time this many entities have
 * arrived and the wind carries the last of it off the pane.
 *
 * Derived from `mythrun_dev` (2026-07-07), entities-per-completed-world:
 *
 *   SELECT w.id, COUNT(e.id) AS entity_count
 *   FROM worlds w JOIN entities e ON e.world_id = w.id
 *   WHERE w.status = 'complete'
 *   GROUP BY w.id ORDER BY entity_count;
 *
 * 23 completed worlds → 36–46 entities each (median ~42). (One additional
 * "complete" row with 0 entities is the hand-seeded "Demo Adventure" dev fixture,
 * id 019700e0-…-000000000002 — excluded.) The floor is ~90% of the observed
 * minimum (0.9 × 36 = 32.4 → 32), slightly conservative so the fog is reliably
 * fully drained before even the sparsest real generation finishes streaming.
 */
export const MIN_EXPECTED_ENTITIES = 32
