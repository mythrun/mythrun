// backend/dev-tool/src/components/character-view-render.ts
//
// myth-94bu — parser + DOM renderer for the character-view panel's
// domain-aware sheet. Pure functions; no shell / API access. Split out
// of character-view-panel.ts to keep that module under the 400-line
// project ceiling.

interface CharacterCore {
  readonly name: string
  readonly level: number
  readonly class: string
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hit_points: number
  readonly max_hit_points: number
  readonly armor_class: number
  readonly proficiency_bonus: number
}

interface CharacterFeature {
  readonly feature_name: string
  readonly feature_source: string
  readonly description: string
}

interface CharacterEquipment {
  readonly item_name: string
  readonly quantity: number
  readonly equipped: boolean
}

interface CharacterSpell {
  readonly spell_name: string
  readonly spell_level: number
  readonly prepared: boolean
}

interface CharacterBody {
  readonly character: CharacterCore | null
  readonly features: readonly CharacterFeature[]
  readonly equipment: readonly CharacterEquipment[]
  readonly spells: readonly CharacterSpell[]
}

function isStringField(rec: Record<string, unknown>, key: string): boolean {
  return typeof rec[key] === 'string'
}

function isNumberField(rec: Record<string, unknown>, key: string): boolean {
  return typeof rec[key] === 'number'
}

function parseCore(value: unknown): CharacterCore | null {
  if (typeof value !== 'object' || value === null) return null
  const c = value as Record<string, unknown>
  const stringKeys = ['name', 'class', 'species', 'background']
  const numberKeys = [
    'level',
    'str',
    'dex',
    'con',
    'int',
    'wis',
    'cha',
    'hit_points',
    'max_hit_points',
    'armor_class',
    'proficiency_bonus',
  ]
  for (const k of stringKeys) if (!isStringField(c, k)) return null
  for (const k of numberKeys) if (!isNumberField(c, k)) return null
  return {
    name: c.name as string,
    level: c.level as number,
    class: c.class as string,
    species: c.species as string,
    background: c.background as string,
    str: c.str as number,
    dex: c.dex as number,
    con: c.con as number,
    int: c.int as number,
    wis: c.wis as number,
    cha: c.cha as number,
    hit_points: c.hit_points as number,
    max_hit_points: c.max_hit_points as number,
    armor_class: c.armor_class as number,
    proficiency_bonus: c.proficiency_bonus as number,
  }
}

function parseFeatures(raw: unknown): readonly CharacterFeature[] {
  if (!Array.isArray(raw)) return []
  const out: CharacterFeature[] = []
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue
    const fr = f as Record<string, unknown>
    if (
      isStringField(fr, 'feature_name') &&
      isStringField(fr, 'feature_source') &&
      isStringField(fr, 'description')
    ) {
      out.push({
        feature_name: fr.feature_name as string,
        feature_source: fr.feature_source as string,
        description: fr.description as string,
      })
    }
  }
  return out
}

function parseEquipment(raw: unknown): readonly CharacterEquipment[] {
  if (!Array.isArray(raw)) return []
  const out: CharacterEquipment[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const er = e as Record<string, unknown>
    if (
      isStringField(er, 'item_name') &&
      isNumberField(er, 'quantity') &&
      typeof er.equipped === 'boolean'
    ) {
      out.push({
        item_name: er.item_name as string,
        quantity: er.quantity as number,
        equipped: er.equipped,
      })
    }
  }
  return out
}

function parseSpells(raw: unknown): readonly CharacterSpell[] {
  if (!Array.isArray(raw)) return []
  const out: CharacterSpell[] = []
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue
    const sr = s as Record<string, unknown>
    if (
      isStringField(sr, 'spell_name') &&
      isNumberField(sr, 'spell_level') &&
      typeof sr.prepared === 'boolean'
    ) {
      out.push({
        spell_name: sr.spell_name as string,
        spell_level: sr.spell_level as number,
        prepared: sr.prepared,
      })
    }
  }
  return out
}

export function parseCharacter(body: unknown): CharacterBody {
  if (typeof body !== 'object' || body === null) {
    return { character: null, features: [], equipment: [], spells: [] }
  }
  const rec = body as Record<string, unknown>
  return {
    character: parseCore(rec.character),
    features: parseFeatures(rec.features),
    equipment: parseEquipment(rec.equipment),
    spells: parseSpells(rec.spells),
  }
}

function modifier(score: number): string {
  const m = Math.floor((score - 10) / 2)
  return m >= 0 ? `+${String(m)}` : String(m)
}

function renderAbilityRow(parent: HTMLElement, c: CharacterCore): void {
  const tableEl = document.createElement('table')
  tableEl.style.borderCollapse = 'collapse'
  tableEl.style.marginTop = '8px'
  tableEl.style.fontFamily = 'var(--mono)'
  tableEl.style.fontSize = '12px'

  const labels: readonly [string, number][] = [
    ['STR', c.str],
    ['DEX', c.dex],
    ['CON', c.con],
    ['INT', c.int],
    ['WIS', c.wis],
    ['CHA', c.cha],
  ]

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const [label] of labels) {
    const th = document.createElement('th')
    th.textContent = label
    th.style.padding = '2px 10px'
    th.style.color = 'var(--fg-muted)'
    th.style.fontWeight = '500'
    th.style.borderBottom = '1px solid var(--border-soft)'
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  tableEl.appendChild(thead)

  const tbody = document.createElement('tbody')
  const bodyRow = document.createElement('tr')
  for (const [, score] of labels) {
    const td = document.createElement('td')
    td.style.padding = '4px 10px'
    td.style.textAlign = 'center'
    td.style.color = 'var(--fg-emphasis)'
    const scoreEl = document.createElement('span')
    scoreEl.style.fontWeight = '600'
    scoreEl.textContent = String(score)
    const modEl = document.createElement('span')
    modEl.style.color = 'var(--fg-muted)'
    modEl.style.marginLeft = '4px'
    modEl.textContent = `(${modifier(score)})`
    td.appendChild(scoreEl)
    td.appendChild(modEl)
    bodyRow.appendChild(td)
  }
  tbody.appendChild(bodyRow)
  tableEl.appendChild(tbody)
  parent.appendChild(tableEl)
}

function renderVitals(parent: HTMLElement, c: CharacterCore): void {
  const dl = document.createElement('dl')
  dl.style.display = 'grid'
  dl.style.gridTemplateColumns = 'auto 1fr auto 1fr auto 1fr'
  dl.style.gap = '4px 12px'
  dl.style.margin = '8px 0 0 0'
  dl.style.fontSize = '12px'
  dl.style.fontFamily = 'var(--mono)'

  const pairs: readonly [string, string][] = [
    ['HP', `${String(c.hit_points)} / ${String(c.max_hit_points)}`],
    ['AC', String(c.armor_class)],
    ['Prof', `+${String(c.proficiency_bonus)}`],
  ]
  for (const [k, v] of pairs) {
    const dt = document.createElement('dt')
    dt.textContent = k
    dt.style.color = 'var(--fg-muted)'
    const dd = document.createElement('dd')
    dd.textContent = v
    dd.style.color = 'var(--fg-emphasis)'
    dd.style.margin = '0'
    dl.appendChild(dt)
    dl.appendChild(dd)
  }
  parent.appendChild(dl)
}

function renderListSection<T>(
  parent: HTMLElement,
  title: string,
  items: readonly T[],
  describe: (item: T) => string,
): void {
  const section = document.createElement('section')
  section.style.marginTop = '12px'
  const h = document.createElement('h2')
  h.style.fontSize = '12px'
  h.style.fontWeight = '600'
  h.style.color = 'var(--fg-emphasis)'
  h.style.margin = '0 0 4px 0'
  h.textContent = `${title} (${String(items.length)})`
  section.appendChild(h)
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(none)'
    section.appendChild(empty)
    parent.appendChild(section)
    return
  }
  const ul = document.createElement('ul')
  ul.style.margin = '0'
  ul.style.padding = '0 0 0 16px'
  ul.style.fontSize = '12px'
  ul.style.color = 'var(--fg-default)'
  for (const it of items) {
    const li = document.createElement('li')
    li.textContent = describe(it)
    li.style.margin = '2px 0'
    ul.appendChild(li)
  }
  section.appendChild(ul)
  parent.appendChild(section)
}

export function renderCharacterSheet(
  parent: HTMLElement,
  body: CharacterBody,
): void {
  const card = document.createElement('section')
  card.setAttribute('data-region', 'character-sheet')
  card.style.marginTop = '8px'
  card.style.padding = '12px'
  card.style.background = 'var(--bg-elevated)'
  card.style.border = '1px solid var(--border-soft)'
  card.style.borderRadius = '4px'

  const c = body.character
  if (c === null) {
    const empty = document.createElement('div')
    empty.style.color = 'var(--fg-muted)'
    empty.style.fontSize = '12px'
    empty.textContent = '(character data missing or malformed)'
    card.appendChild(empty)
    parent.appendChild(card)
    return
  }

  const name = document.createElement('h2')
  name.style.fontSize = '18px'
  name.style.fontWeight = '600'
  name.style.color = 'var(--fg-emphasis)'
  name.style.margin = '0'
  name.textContent = c.name
  card.appendChild(name)

  const sub = document.createElement('div')
  sub.style.fontSize = '12px'
  sub.style.color = 'var(--fg-muted)'
  sub.style.marginTop = '2px'
  sub.textContent = `${c.species} · ${c.class} · level ${String(c.level)} · ${c.background}`
  card.appendChild(sub)

  renderAbilityRow(card, c)
  renderVitals(card, c)
  renderListSection(
    card,
    'Features',
    body.features,
    (f) => `${f.feature_name} — ${f.feature_source}: ${f.description}`,
  )
  renderListSection(
    card,
    'Equipment',
    body.equipment,
    (e) =>
      `${e.item_name} ×${String(e.quantity)}${e.equipped ? ' (equipped)' : ''}`,
  )
  renderListSection(
    card,
    'Spells',
    body.spells,
    (s) =>
      `${s.spell_name} (level ${String(s.spell_level)})${s.prepared ? ' — prepared' : ''}`,
  )

  parent.appendChild(card)
}
