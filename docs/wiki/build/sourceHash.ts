import { createHash } from 'node:crypto'
import { readFile, lstat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative as relativePath, resolve as resolvePath } from 'node:path'

const execFileAsync = promisify(execFile)

async function rawEnumerate(absPath: string): Promise<string[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const nested: string[][] = await Promise.all(
    entries.map(async (entry) => {
      const childAbs = join(absPath, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in tracked source paths: ${childAbs}`)
      }
      if (entry.isDirectory()) return rawEnumerate(childAbs)
      if (entry.isFile()) return [childAbs]
      return []
    }),
  )
  return nested.flat()
}

/**
 * Enumerate files under a directory via `git ls-files --cached --others
 * --exclude-standard`. This honors .gitignore so locally-generated artifacts
 * (.terraform provider binaries, node_modules, dist output, etc.) don't
 * poison the source-hash on dev vs CI. Returns absolute paths, or null if
 * the path isn't inside a git repo.
 */
async function gitEnumerate(absPath: string): Promise<string[] | null> {
  let repoRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', absPath, 'rev-parse', '--show-toplevel'])
    repoRoot = stdout.trim()
  } catch {
    return null
  }

  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      repoRoot,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      absPath,
    ],
    // Large repos can return lots of paths; bump the buffer cap.
    { maxBuffer: 50 * 1024 * 1024 },
  )
  const relFiles = stdout.split('\0').filter(Boolean)
  return relFiles.map((f) => join(repoRoot, f))
}

async function enumerateFiles(absPath: string): Promise<string[]> {
  const stats = await lstat(absPath).catch((err: unknown) => {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Source path does not exist: ${absPath}`)
    }
    throw err
  })
  if (stats.isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in tracked source paths: ${absPath}`)
  }
  if (stats.isFile()) return [absPath]
  if (!stats.isDirectory()) return []

  // Prefer git-aware enumeration so .gitignore is honored. This makes the
  // source-hash portable — a local-only file (e.g. infra/.terraform/ providers
  // or backend/node_modules) does not change the hash on dev vs CI.
  const gitList = await gitEnumerate(absPath)
  if (gitList !== null) {
    // git ls-files may report symlinks as regular entries; reject them
    // explicitly to preserve the existing policy.
    for (const f of gitList) {
      const s = await lstat(f)
      if (s.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in tracked source paths: ${f}`)
      }
    }
    return gitList
  }

  // Path isn't inside a git repo — fall back to raw fs walk.
  return rawEnumerate(absPath)
}

export async function computeSourceHash(paths: string[], root: string): Promise<string> {
  const absoluteRoot = resolvePath(root)
  const absolutePaths = paths.map((p) => resolvePath(absoluteRoot, p))
  const fileLists = await Promise.all(absolutePaths.map((p) => enumerateFiles(p)))
  const allFiles = fileLists.flat().sort()

  // Include the declared path list itself in the digest so that `[dirA]` and
  // `[dirA, fileB]` with identical underlying file contents produce distinct
  // hashes. JSON.stringify avoids any ambiguity in separator handling if a
  // path ever contains a newline.
  const outer = createHash('sha256')
  outer.update(JSON.stringify(paths))
  outer.update('\n---\n')

  for (const file of allFiles) {
    const rel = relativePath(absoluteRoot, file)
    const content = await readFile(file)
    const per = createHash('sha256')
    per.update(rel)
    per.update('\x00')
    per.update(content)
    outer.update(per.digest('hex'))
  }

  return outer.digest('hex')
}
