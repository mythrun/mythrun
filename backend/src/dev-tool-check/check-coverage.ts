// Pure check logic, decoupled from filesystem I/O. The CLI shell at
// backend/scripts/dev-tool-check.ts loads the contracts and coverage
// JSON and passes them in. Tests use this function directly.

const MIN_REASON_LENGTH = 20

export interface Contracts {
  readonly routes: readonly string[]
  readonly events: readonly string[]
  readonly jobs: readonly string[]
}

export interface Coverage {
  readonly version: 1
  readonly routes: readonly string[]
  readonly events: readonly string[]
  readonly jobs: readonly string[]
  readonly exempt: {
    readonly routes: Readonly<Record<string, string>>
    readonly events: Readonly<Record<string, string>>
    readonly jobs: Readonly<Record<string, string>>
  }
}

export interface CheckResult {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

type Kind = 'routes' | 'events' | 'jobs'

export function checkCoverage(contracts: Contracts, coverage: Coverage): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Cast through unknown for the runtime version guard: the type narrows to
  // literal `1`, but a malformed coverage.json on disk could supply anything.
  const rawVersion: unknown = coverage.version
  if (rawVersion !== 1) {
    errors.push(
      `coverage.json version ${String(rawVersion)} not understood by this script`,
    )
    return { errors, warnings }
  }

  const kinds: readonly (readonly [Kind, readonly string[]])[] = [
    ['routes', contracts.routes],
    ['events', contracts.events],
    ['jobs', contracts.jobs],
  ]

  for (const [kind, contract] of kinds) {
    const coveredList: readonly string[] = coverage[kind]
    const exempt: Readonly<Record<string, string>> = coverage.exempt[kind]
    const covered = new Set(coveredList)
    const contractSet = new Set(contract)

    for (const entry of contract) {
      if (covered.has(entry)) continue
      const reason = exempt[entry]
      if (reason !== undefined) {
        if (reason.trim().length < MIN_REASON_LENGTH) {
          errors.push(
            `${kind}/${entry} exempt reason is too short (< ${String(MIN_REASON_LENGTH)} chars). Write a real reason: who, why, and which Linear/MYT-* issue addresses the gap.`,
          )
        }
        continue
      }
      errors.push(
        `${kind}/${entry} is in contract but not in coverage and not in exempt — add a dev-tool UI for it (and add the entry to backend/dev-tool/coverage.json), OR add it to coverage.exempt.${kind} with a reason.`,
      )
    }

    for (const entry of coveredList) {
      if (!contractSet.has(entry)) {
        warnings.push(
          `${kind}/${entry} is in coverage but no longer in contract — consider removing`,
        )
      }
    }

    for (const entry of Object.keys(exempt)) {
      if (!contractSet.has(entry)) {
        errors.push(
          `${kind}/${entry} is in exempt but no longer in contract — remove the exempt entry`,
        )
      }
    }
  }

  return { errors, warnings }
}
