import { createHash } from 'node:crypto'
import { readFile, lstat, readdir } from 'node:fs/promises'
import { join, relative as relativePath, resolve as resolvePath } from 'node:path'

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

  const entries = await readdir(absPath, { withFileTypes: true })
  const nested: string[][] = await Promise.all(
    entries.map(async (entry) => {
      const childAbs = join(absPath, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in tracked source paths: ${childAbs}`)
      }
      if (entry.isDirectory()) return enumerateFiles(childAbs)
      if (entry.isFile()) return [childAbs]
      return []
    }),
  )
  return nested.flat()
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
