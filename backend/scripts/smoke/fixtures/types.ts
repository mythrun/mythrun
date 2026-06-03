// Reusable smoke-fixture toolkit (MYT-64). A fixture is a captured snapshot of a
// real DB entity-graph, replayed into mythrun_test for a smoke. See
// docs/superpowers/specs/2026-06-03-myt-64-session-prep-smoke-design.md §3.

/** Root ids a manifest's filters are scoped to. */
export interface FixtureRootIds {
  readonly campaignId: string
  readonly worldId: string
}

/** One table in a fixture's capture manifest (capture-side only). */
export interface FixtureTableManifest {
  readonly name: string
  /** `true` → a globalSetup-seeded shared row (e.g. dev users): the loader INSERTs it
   *  ON CONFLICT DO NOTHING and NEVER deletes it (deleting would corrupt the shared seed). */
  readonly shared?: boolean
  /** Root-scoped SELECT filter used by capture.ts to pull this table's rows. */
  readonly filter: (ids: FixtureRootIds) => { readonly sql: string; readonly params: readonly unknown[] }
}

/** A fixture's capture manifest: the durable record of "what graph this fixture is."
 *  Tables MUST be in FK-dependency order (parents before children). */
export interface FixtureManifest {
  readonly name: string
  readonly tables: readonly FixtureTableManifest[]
}

/** One table's captured rows in the committed JSON (load-side; self-contained). */
export interface FixtureTableData {
  readonly name: string
  readonly shared: boolean
  readonly rows: readonly Record<string, unknown>[]
}

/** The committed `<name>.json` shape. `loadFixture` needs only this — never the manifest. */
export interface FixtureFile {
  readonly name: string
  readonly capturedAt: string
  readonly schemaVersion: string
  readonly rootCampaignId: string
  readonly rootWorldId: string
  readonly tables: readonly FixtureTableData[]
}
