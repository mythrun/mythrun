-- backend/migrations/015_vocabulary_registry.sql
-- myth-pfke: per-world vocabulary registry. Stored as a single jsonb
-- document with shape {entries: [...], adjacent_franchises: [...]}.
-- Entries are validated at the application layer (Zod) — the CHECK
-- constraint here only enforces top-level object shape.
--
-- Backfill: existing worlds get the default empty registry. Cosmetic —
-- their stages are already done; downstream stages don't re-run for
-- completed worlds. New worlds after this migration get a populated
-- registry from stage 1.5 (vocabulary_intake).

ALTER TABLE worlds ADD COLUMN vocabulary_registry jsonb NOT NULL
  DEFAULT '{"entries": [], "adjacent_franchises": []}'::jsonb;

ALTER TABLE worlds ADD CONSTRAINT worlds_vocabulary_registry_shape
  CHECK (
    jsonb_typeof(vocabulary_registry) = 'object'
    AND jsonb_typeof(vocabulary_registry->'entries') = 'array'
    AND jsonb_typeof(vocabulary_registry->'adjacent_franchises') = 'array'
  );
