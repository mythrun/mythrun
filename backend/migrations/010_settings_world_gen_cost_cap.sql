-- backend/migrations/010_settings_world_gen_cost_cap.sql
--
-- Per MYT-51 D11: the world-gen worker reads `settings.world_gen_cost_cap_usd`
-- at the start of every stage. Default of 10.0 USD (per parent spec §3.4).
-- This migration only INSERTs if the row is absent so dev environments
-- with a manually-tuned cap (smoke-testing the breaker) aren't reset.

INSERT INTO settings (key, value)
VALUES ('world_gen_cost_cap_usd', '10.0')
ON CONFLICT (key) DO NOTHING;
