#!/usr/bin/env tsx
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBuild, type BuildMode } from './build/buildPipeline.ts'
import { structure } from './structure.ts'

const here = dirname(fileURLToPath(import.meta.url))

function parseMode(argv: string[]): BuildMode {
  if (argv.includes('--check')) return 'check'
  if (argv.includes('--accept-drift')) return 'accept-drift'
  return 'build'
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const result = await runBuild({ root: here, structure, mode })

  for (const warning of result.warnings) {
    console.warn('⚠️', warning)
  }
  for (const error of result.errors) {
    console.error('✗', error)
  }
  console.log(
    `${mode === 'check' ? 'checked' : 'built'} ${String(result.pagesRendered)} pages, ${String(result.diagramsRendered)} diagrams, ${String(result.errors.length)} errors`,
  )

  process.exit(result.exitCode)
}

main().catch((err: unknown) => {
  console.error('build failed:', err)
  process.exit(2)
})
