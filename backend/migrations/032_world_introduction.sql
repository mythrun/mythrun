-- backend/migrations/032_world_introduction.sql
--
-- myth-zaqxh / world_introduction stage.
--
-- worlds.introduction — the introduction page every generated world opens on
-- (the first prose the player reads at the reveal). Written ONCE by the
-- world_introduction stage, then read by the world-snapshot view. A set-once
-- CONTENT column (like world_overview / starting_situations), so NULLABLE:
-- absent until the stage commits, and the snapshot's 409 gate keys on that
-- stage so a served snapshot always has it.
--
-- Shape: { "prose": <text>, "references": [ { "entityId": <uuid>, "name": <text> }, ... ] }
-- The title is NOT stored here — it is the world's name (worlds.name), composed
-- at read time. entityIds live inside the JSONB (no FK); the snapshot view
-- re-filters references against the served known-tier entity set, so a
-- (hypothetically) stale id is dropped at compose time rather than dangling.
--
-- The shape CHECK allows NULL (set-once) but pins the object/prose/references
-- shape when present, mirroring the worlds.entity_consolidation_pending guard.

ALTER TABLE worlds
  ADD COLUMN introduction JSONB;

ALTER TABLE worlds
  ADD CONSTRAINT worlds_introduction_shape
  CHECK (
    introduction IS NULL
    OR (
      jsonb_typeof(introduction) = 'object'
      AND jsonb_typeof(introduction->'prose') = 'string'
      AND jsonb_typeof(introduction->'references') = 'array'
    )
  );
