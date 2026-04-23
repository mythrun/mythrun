import { createHash } from 'node:crypto'
import { readFile, stat, readdir } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'

async function enumerateFiles(path: string): Promise<string[]> {
  const stats = await stat(path).catch((err: unknown) => {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Source path does not exist: ${path}`)
    }
    throw err
  })
  if (stats.isFile()) return [path]
  const entries = await readdir(path, { withFileTypes: true })
  const nested: string[][] = await Promise.all(
    entries.map(async (entry) => {
      const childPath = join(path, entry.name)
      if (entry.isDirectory()) return enumerateFiles(childPath)
      if (entry.isFile()) return [childPath]
      return []
    }),
  )
  return nested.flat()
}

export async function computeSourceHash(paths: string[]): Promise<string> {
  const absolutePaths = paths.map((p) => resolvePath(p))
  const fileLists = await Promise.all(absolutePaths.map((p) => enumerateFiles(p)))
  const allFiles = fileLists.flat().sort()

  // Include the declared path list itself in the digest so that `[dirA]` and
  // `[dirA, fileB]` with identical underlying contents produce distinct hashes.
  const outer = createHash('sha256')
  outer.update(paths.join('\n'))
  outer.update('\n---\n')

  for (const file of allFiles) {
    const content = await readFile(file)
    const per = createHash('sha256')
    per.update(file)
    per.update('\x00')
    per.update(content)
    outer.update(per.digest('hex'))
  }

  return outer.digest('hex')
}
