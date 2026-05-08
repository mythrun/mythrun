// Exhaustive list of every Stripe lookup_key Mythrun uses.
//
// Pricing is NOT in this file. Price stays in Stripe. Code that needs
// the live price retrieves it from the Stripe API at runtime via
// stripe.prices.retrieve / list.
//
// Adding a new tier or SKU is a deliberate code change: edit this file,
// run the boot probe to confirm Stripe matches, ship the migration if
// any DB shape needs to change. There is no "dynamic tier" facility.

export type LookupKey =
  | 'tier_wayfarer'
  | 'tier_sojourner'
  | 'tier_mythwright'
  | 'sku_session'
  | 'sku_world'

export interface LookupKeySpec {
  /** The Stripe lookup_key. Single source of truth. */
  readonly lookupKey: LookupKey
  /** User-facing display name. Matches the Stripe product name. */
  readonly displayName: string
  /** 'recurring' = subscription tier; 'one_time' = a-la-carte SKU. */
  readonly type: 'recurring' | 'one_time'
  /** Sessions granted on each successful purchase / billing cycle. */
  readonly sessionsGranted: number
  /** Worlds granted on each successful purchase / billing cycle. */
  readonly worldsGranted: number
}

export const LOOKUP_KEYS = {
  tier_wayfarer: {
    lookupKey: 'tier_wayfarer',
    displayName: 'Wayfarer',
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
  },
  tier_sojourner: {
    lookupKey: 'tier_sojourner',
    displayName: 'Sojourner',
    type: 'recurring',
    sessionsGranted: 8,
    worldsGranted: 2,
  },
  tier_mythwright: {
    lookupKey: 'tier_mythwright',
    displayName: 'Mythwright',
    type: 'recurring',
    sessionsGranted: 16,
    worldsGranted: 4,
  },
  sku_session: {
    lookupKey: 'sku_session',
    displayName: 'Session',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
  },
  sku_world: {
    lookupKey: 'sku_world',
    displayName: 'World',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 1,
  },
} as const satisfies Record<LookupKey, LookupKeySpec>
