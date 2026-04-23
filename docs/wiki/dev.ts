#!/usr/bin/env tsx
// Wiki dev server: serves site/ on localhost, rebuilds on source changes,
// auto-reloads the browser when the build output updates.
//
// Usage: pnpm wiki:dev  (from repo root) or pnpm dev (from docs/wiki/)

import browserSync from 'browser-sync'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WIKI_DEV_PORT ?? '3100')

let building = false
let pending = false

async function runBuild(): Promise<void> {
  if (building) {
    pending = true
    return
  }
  building = true
  await new Promise<void>((done) => {
    const proc = spawn('tsx', ['build.ts'], { cwd: here, stdio: 'inherit' })
    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[wiki-dev] build exited with code ${String(code)}`)
      }
      done()
    })
  })
  building = false
  if (pending) {
    pending = false
    void runBuild()
  }
}

const bs = browserSync.create()

await runBuild()

// Watch source files that drive the build. On change, rebuild — which writes
// to site/, which triggers the browser-sync reload via the `files` config
// passed to init() below. Brace expansion keeps this to a single string
// because the browser-sync type signature only accepts one pattern.
const watcher = bs.watch(
  '{content/**/*,layout/**/*,diagrams/**/*,assets/**/*,structure.ts}',
  { cwd: here, ignoreInitial: true },
)
const onChange = (file: string): void => {
  console.log(`[wiki-dev] changed: ${file}`)
  void runBuild()
}
watcher.on('change', onChange)
watcher.on('add', onChange)
watcher.on('unlink', onChange)

bs.init({
  server: resolve(here, 'site'),
  files: resolve(here, 'site/**/*'),
  port: PORT,
  ui: false,
  notify: false,
  open: false,
  logPrefix: 'wiki',
})
