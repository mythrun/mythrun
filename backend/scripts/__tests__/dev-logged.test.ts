// backend/scripts/__tests__/dev-logged.test.ts
//
// myth-q97j0: `pnpm dev` must start BOTH the API server and the session worker.
// Before this, `pnpm dev` resolved to `scripts/dev-logged.sh`, which booted
// `src/server.ts` only — so every live-session flow (DM turns, session end,
// scribe, reconcile) was silently dead in dev. A 2026-07 playtest ran against a
// 4-day-stale worker because of it.
//
// Two contracts are pinned here:
//   1. The stack TABLE, via the script's `--self-test` mode — the same rows the
//      run path iterates. An edit that drops the worker leg fails here.
//   2. The TEARDOWN, for real: the script is spawned with a fake leg standing in
//      for `tsx watch` (DEV_LOGGED_RUNNER), then sent SIGINT. Both leaf
//      processes must be gone afterwards. An orphaned watcher still holding
//      :3000 or :3001 after Ctrl-C is the same failure class as a missing
//      worker — a dev stack that isn't what it looks like.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(BACKEND_DIR, 'scripts/dev-logged.sh')
const FAKE_LEG = resolve(BACKEND_DIR, 'scripts/__tests__/fixtures/fake-leg.sh')

function selfTest(): string {
  return execFileSync('bash', [SCRIPT, '--self-test'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until `read` returns a value, or throw at the deadline. */
async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await sleep(50)
  }
}

describe('dev-logged.sh --self-test', () => {
  it('exits 0 and reports ok', () => {
    expect(selfTest()).toMatch(/\bok\b/)
  })

  it('declares BOTH dev legs — the API server and the session worker', () => {
    const out = selfTest()
    expect(out).toContain('api\tsrc/server.ts')
    expect(out).toContain('worker\tsrc/worker.ts')
  })

  it('gives each leg its own daily log file so the two streams stay separable', () => {
    const out = selfTest()
    const logs = [...out.matchAll(/logs\/(dev[a-z-]*)-\d{4}-\d{2}-\d{2}\.log/g)].map((m) => m[1])
    // The API keeps the historical `dev-<date>.log` name (myth-lmz6); the
    // worker gets its own file rather than interleaving into the same one.
    expect(logs).toEqual(['dev', 'dev-worker'])
  })
})

describe('dev-logged.sh supervisor', () => {
  let logDir: string | undefined

  afterEach(() => {
    if (logDir !== undefined) rmSync(logDir, { recursive: true, force: true })
    logDir = undefined
  })

  it('starts both legs, and a Ctrl-C kills both — no orphaned watcher', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'mythrun-dev-stack-'))
    const dir = logDir
    const child = spawn('bash', [SCRIPT], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DEV_LOGGED_LOG_DIR: dir, DEV_LOGGED_RUNNER: FAKE_LEG },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      // Each fake leg writes its own pid once the supervisor has launched it.
      const readPid =
        (entry: string) =>
        (): number | undefined => {
          try {
            return Number(readFileSync(join(dir, `${entry}.pid`), 'utf8').trim())
          } catch {
            return undefined
          }
        }
      const serverPid = await until(readPid('server'), 10_000)
      const workerPid = await until(readPid('worker'), 10_000)
      expect(isAlive(serverPid)).toBe(true)
      expect(isAlive(workerPid)).toBe(true)

      child.kill('SIGINT')
      const exit = await new Promise<number | null>((r) => {
        child.on('exit', (code) => {
          r(code)
        })
      })
      // 130 = the shell's conventional "terminated by SIGINT".
      expect(exit).toBe(130)

      // The supervisor must have taken the LEAF processes with it, not just the
      // subshells it tracks.
      await until(() => (!isAlive(serverPid) && !isAlive(workerPid) ? true : undefined), 5_000)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
