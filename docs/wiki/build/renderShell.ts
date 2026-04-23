const slotRegex = /<!--\s*@(\w+)\s*-->/g

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

  return shell.replace(slotRegex, (_full, name: string) => slots[name] ?? '')
}
