// backend/src/__tests__/_helpers/seed-test-database.ts
//
// Idempotent test-database seed. Called once per worker process by
// Vitest globalSetup. Inserts the system user, demo world, dev users
// (1..5), and the cost-cap settings rows. ON CONFLICT DO NOTHING makes
// this safe to call multiple times.
//
// Tests should NEVER call this — globalSetup handles it. Tests should
// also NEVER delete these rows; they're outside any test scope.
//
// myth-oehx. Lifted out of _helpers/reset-data.ts when that file was
// deleted in Phase 5.

import type { Pool } from 'pg'

export async function seedTestDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used, suspended_at)
     VALUES ($1, 'system:mythrun', 'Mythrun System', 'system', true, '1970-01-01 00:00:00+00'::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    ['019700e0-0000-7000-8000-000000000001'],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status, language, is_public, is_demo)
     VALUES ($1, $2, 'Demo Adventure', 'Trial-mode demo world. Narrative content authored separately.', 'complete', 'en', false, true)
     ON CONFLICT (id) DO NOTHING`,
    ['019700e0-0000-7000-8000-000000000002', '019700e0-0000-7000-8000-000000000001'],
  )
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
     VALUES
       ('019700e0-0000-7000-8000-00000000d001', 'dev-user-1', 'Dev User 1', 'devuser1', true),
       ('019700e0-0000-7000-8000-00000000d002', 'dev-user-2', 'Dev User 2', 'devuser2', true),
       ('019700e0-0000-7000-8000-00000000d003', 'dev-user-3', 'Dev User 3', 'devuser3', true),
       ('019700e0-0000-7000-8000-00000000d004', 'dev-user-4', 'Dev User 4', 'devuser4', true),
       ('019700e0-0000-7000-8000-00000000d005', 'dev-user-5', 'Dev User 5', 'devuser5', true)
     ON CONFLICT (id) DO NOTHING`,
  )
  await pool.query(
    `INSERT INTO settings (key, value) VALUES
       ('world_gen_cost_cap_usd', '10.0'),
       ('character_creation_cost_cap_usd', '5.00')
     ON CONFLICT (key) DO NOTHING`,
  )
}
