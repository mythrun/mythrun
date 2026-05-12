#!/usr/bin/env tsx
// Ship gate CLI. Loads contract constants and the coverage manifest,
// invokes the pure checkCoverage function, prints results, exits 0/1.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PIPELINE_ROUTES } from '../src/contract/pipeline-routes.js'
import { PIPELINE_SSE_EVENTS } from '../src/contract/pipeline-events.js'
import { PIPELINE_JOBS } from '../src/contract/pipeline-jobs.js'
import { checkCoverage, type Coverage } from '../src/dev-tool-check/check-coverage.js'

const here = dirname(fileURLToPath(import.meta.url))
const coveragePath = join(here, '..', 'dev-tool', 'coverage.json')
const raw = await readFile(coveragePath, 'utf8')
const coverage = JSON.parse(raw) as Coverage

const result = checkCoverage(
  {
    routes: PIPELINE_ROUTES,
    events: PIPELINE_SSE_EVENTS,
    jobs: PIPELINE_JOBS,
  },
  coverage,
)

for (const w of result.warnings) {
  console.warn(`warn:  ${w}`)
}
for (const e of result.errors) {
  console.error(`error: ${e}`)
}

const summary = `routes:${String(coverage.routes.length)} events:${String(coverage.events.length)} jobs:${String(coverage.jobs.length)}`
console.log(
  `dev-tool:check — ${String(result.errors.length)} error(s), ${String(result.warnings.length)} warning(s) [${summary}]`,
)
process.exit(result.errors.length > 0 ? 1 : 0)
