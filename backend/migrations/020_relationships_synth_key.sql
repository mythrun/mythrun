-- backend/migrations/020_relationships_synth_key.sql
--
-- myth-p4sz: persist a synth_key on relationships so stage 7 can look up
-- the wire-format identity of an existing row when emitting edge-removed
-- events (previously broken by a misnamed map; see coherence-pass.ts).
--
-- Nullable + best-effort backfill: existing rows lose the original
-- sourceIndex, so we synthesize a placeholder per row keyed by lexical
-- order. Future rows (stages 4 / 4b / 7) carry the real synthKey.

ALTER TABLE relationships
  ADD COLUMN synth_key TEXT NULL;

-- Backfill: deterministic placeholder for existing rows. row_number() over
-- a stable ordering (id ASC) gives a per-relationship sequence; stage 7
-- doesn't care about the value's exact shape, only that the lookup
-- succeeds.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS seq
    FROM relationships
)
UPDATE relationships r
   SET synth_key = 'entity_relationships/relationships/' || numbered.seq
  FROM numbered
 WHERE numbered.id = r.id;
