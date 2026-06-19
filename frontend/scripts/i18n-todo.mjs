// Lists every locale value still holding a `[placeholder for …]` so unwritten
// copy is findable. JSON-walks values (not a line-grep) so it survives nested +
// `_one`/`_other` plural key shapes.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/i18n/locales/', import.meta.url).pathname

function* jsonFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* jsonFiles(p)
    else if (name.endsWith('.json')) yield p
  }
}

function* placeholders(value, path) {
  if (typeof value === 'string') {
    if (value.startsWith('[placeholder for')) yield `${path} = ${value}`
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* placeholders(v, `${path}.${k}`)
  }
}

let count = 0
for (const file of jsonFiles(ROOT)) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const line of placeholders(data, file.replace(ROOT, ''))) {
    console.log(line)
    count++
  }
}
console.log(`\n${count} placeholder value(s) awaiting copy.`)
