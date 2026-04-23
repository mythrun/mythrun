export function renderShell(shell: string, slots: Record<string, string>): string {
  const required = new Set<string>()
  const scanRegex = /<!--\s*@(\w+)\s*-->/g
  for (let m = scanRegex.exec(shell); m !== null; m = scanRegex.exec(shell)) {
    const name = m[1]
    if (name !== undefined) required.add(name)
  }

  for (const slot of required) {
    if (!(slot in slots)) {
      throw new Error(`renderShell: missing slot "${slot}" in provided values`)
    }
  }
  for (const key of Object.keys(slots)) {
    if (!required.has(key)) {
      throw new Error(`renderShell: unknown slot "${key}" — no <!-- @${key} --> marker in shell`)
    }
  }

  // Function-local to avoid module-level /g regex lastIndex state. Safe today
  // because String.prototype.replace resets internally, but a latent footgun
  // if a future refactor moves this to exec() in a loop.
  const replaceRegex = /<!--\s*@(\w+)\s*-->/g
  return shell.replace(replaceRegex, (_full, name: string) => slots[name] ?? '')
}
