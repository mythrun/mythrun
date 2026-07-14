// MYT-51 T13 — campaign-create form-field scaffolding.
//
// Pure DOM builders for the mode toggle + the freeform / guided input
// groups. Split out of campaign-create-panel.ts (myth-qtw77); no closure
// state, no wire access — just element construction the dom module
// assembles.

export type Mode = 'freeform' | 'guided'

export interface ModeToggle {
  readonly row: HTMLElement
  readonly freeformRadio: HTMLInputElement
  readonly guidedRadio: HTMLInputElement
}

export function buildModeToggle(): ModeToggle {
  const row = document.createElement('div')
  row.style.display = 'flex'
  row.style.gap = '12px'
  row.style.marginBottom = '12px'

  const freeformLabel = document.createElement('label')
  const freeformRadio = document.createElement('input')
  freeformRadio.type = 'radio'
  freeformRadio.name = 'mythrun-create-mode'
  freeformRadio.value = 'freeform'
  freeformRadio.checked = true
  freeformLabel.appendChild(freeformRadio)
  freeformLabel.append(' freeform')

  const guidedLabel = document.createElement('label')
  const guidedRadio = document.createElement('input')
  guidedRadio.type = 'radio'
  guidedRadio.name = 'mythrun-create-mode'
  guidedRadio.value = 'guided'
  guidedLabel.appendChild(guidedRadio)
  guidedLabel.append(' guided (3 picks)')

  row.appendChild(freeformLabel)
  row.appendChild(guidedLabel)
  return { row, freeformRadio, guidedRadio }
}

export interface GuidedFields {
  readonly wrap: HTMLElement
  readonly titleInputs: readonly HTMLInputElement[]
  readonly whyInputs: readonly HTMLTextAreaElement[]
}

export function buildGuidedFields(): GuidedFields {
  const wrap = document.createElement('div')
  wrap.style.display = 'none'
  const titleInputs: HTMLInputElement[] = []
  const whyInputs: HTMLTextAreaElement[] = []
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div')
    row.style.marginBottom = '8px'

    const heading = document.createElement('div')
    heading.style.fontSize = '12px'
    heading.style.color = 'var(--fg-muted)'
    heading.style.marginBottom = '4px'
    heading.textContent = `Pick ${String(i + 1)}`

    const titleEl = document.createElement('input')
    titleEl.type = 'text'
    titleEl.placeholder = 'title (≤200 chars)'
    titleEl.style.width = '100%'
    titleEl.style.marginBottom = '4px'

    const whyEl = document.createElement('textarea')
    whyEl.placeholder = 'whyILikeIt (≤800 chars)'
    whyEl.rows = 2
    whyEl.style.width = '100%'
    whyEl.style.fontFamily = 'inherit'
    whyEl.style.fontSize = '13px'

    row.appendChild(heading)
    row.appendChild(titleEl)
    row.appendChild(whyEl)
    wrap.appendChild(row)
    titleInputs.push(titleEl)
    whyInputs.push(whyEl)
  }
  return { wrap, titleInputs, whyInputs }
}

export function buildFreeformFields(): { wrap: HTMLElement; textarea: HTMLTextAreaElement } {
  const wrap = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.placeholder = 'concept (20-4000 chars)'
  textarea.rows = 5
  textarea.style.width = '100%'
  textarea.style.fontFamily = 'inherit'
  textarea.style.fontSize = '13px'
  wrap.appendChild(textarea)
  return { wrap, textarea }
}
