-- Relationships gain an access tier so the world-gen reveal (RELATED footer + graph edges)
-- can filter to known-tier — closing the enforced-ignorance leak where a secret connection
-- between two known entities would otherwise surface. Mirrors 014's facts/entities tiering.
ALTER TABLE relationships
  ADD COLUMN access_level TEXT NOT NULL DEFAULT 'secret'
  CHECK (access_level IN ('known', 'discoverable', 'secret'));
