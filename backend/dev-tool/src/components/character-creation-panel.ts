// MYT-53 T23 — character-creation-panel.
//
// Drives the 9 MYT-53 character-creation routes. Binds to
// `mythrun.watchcampaign` (same event the status / live-events / world-
// snapshot panels listen to) so the active campaign is picked up from
// my-campaigns without an extra input. On bind the panel fetches the
// roster + starting-situations in parallel; everything else is a
// click-driven action that calls a route then re-renders.
//
// State machine:
//   idle    — no campaign bound (initial + after closewatch)
//   loading — bind / refresh in flight
//   ready   — roster + situations rendered (or 404 world_not_ready
//             surfaced inline, which is still a valid render — the
//             panel never flips to 'error' for that case because the
//             campaign exists and the user can still try other surfaces)
//   error   — last refresh hit a non-404, non-200 status
//
// XSS safety: every server-returned or user-entered string lands via
// el.textContent. No innerHTML on dynamic data. The roster + the three
// starting-situation prose strings are LLM-authored; the conceptText +
// situationGroundingText textareas echo back to the user with their own
// input — same Roc-C2 textContent rule applies.

import { apiCall } from '../api-client.js'

// ---- Wire types ----

interface SituationEntry {
  readonly index: number
  readonly locationEntityId: string
  readonly prose: string
}

interface SituationsResponse {
  readonly situations: readonly SituationEntry[]
  readonly chosenIndex: number | null
}

interface RosterMember {
  readonly userId: string
  readonly displayName: string
  readonly conceptStatus: string
  readonly characterId?: string
}

interface RosterResponse {
  readonly members: readonly RosterMember[]
}

interface ErrorEnvelope {
  readonly code?: string
}

// ---- DOM scaffold ----

interface ViewRefs {
  readonly card: HTMLElement
  readonly status: HTMLElement
  readonly situations: HTMLElement
  readonly roster: HTMLElement
  readonly form: HTMLElement
  readonly other: HTMLElement
  readonly conceptInput: HTMLTextAreaElement
  readonly groundingInput: HTMLTextAreaElement
  readonly submitBtn: HTMLButtonElement
  readonly archiveBtn: HTMLButtonElement
  readonly hierarchyBtn: HTMLButtonElement
  readonly tablesBtn: HTMLButtonElement
  readonly startCreationBtn: HTMLButtonElement
  readonly detail: HTMLElement
}

function buildView(): ViewRefs {
  const card = document.createElement('section')
  card.className = 'card'
  // Event-driven: 'idle' until the user clicks Watch on my-campaigns.
  card.setAttribute('data-state', 'idle')

  const title = document.createElement('h2')
  title.textContent = 'Character creation (MYT-53)'

  const status = document.createElement('div')
  status.className = 'result'
  status.textContent = '(no campaign watched — click Watch on a campaign)'

  const situations = document.createElement('div')
  situations.setAttribute('data-region', 'starting-situations')
  situations.style.marginTop = '12px'

  const roster = document.createElement('div')
  roster.setAttribute('data-region', 'roster')
  roster.style.marginTop = '12px'

  const form = document.createElement('div')
  form.setAttribute('data-region', 'submission-form')
  form.style.marginTop = '12px'
  const formHeading = document.createElement('h3')
  formHeading.style.fontFamily = 'var(--mono)'
  formHeading.style.fontSize = '13px'
  formHeading.style.margin = '0 0 6px 0'
  formHeading.textContent = 'Submit / re-submit your character'
  const conceptLabel = document.createElement('label')
  conceptLabel.style.display = 'block'
  conceptLabel.style.fontFamily = 'var(--mono)'
  conceptLabel.style.fontSize = '12px'
  conceptLabel.style.color = 'var(--fg-muted)'
  conceptLabel.textContent = 'conceptText (20–4000 chars)'
  const conceptInput = document.createElement('textarea')
  conceptInput.rows = 4
  conceptInput.style.width = '100%'
  conceptInput.style.fontFamily = 'var(--mono)'
  conceptInput.style.fontSize = '12px'
  const groundingLabel = document.createElement('label')
  groundingLabel.style.display = 'block'
  groundingLabel.style.fontFamily = 'var(--mono)'
  groundingLabel.style.fontSize = '12px'
  groundingLabel.style.color = 'var(--fg-muted)'
  groundingLabel.style.marginTop = '8px'
  groundingLabel.textContent = 'situationGroundingText (20–2000 chars)'
  const groundingInput = document.createElement('textarea')
  groundingInput.rows = 3
  groundingInput.style.width = '100%'
  groundingInput.style.fontFamily = 'var(--mono)'
  groundingInput.style.fontSize = '12px'
  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Submit character'
  submitBtn.style.marginTop = '6px'
  form.appendChild(formHeading)
  form.appendChild(conceptLabel)
  form.appendChild(conceptInput)
  form.appendChild(groundingLabel)
  form.appendChild(groundingInput)
  form.appendChild(submitBtn)

  const other = document.createElement('div')
  other.setAttribute('data-region', 'other-views')
  other.style.marginTop = '12px'
  const otherHeading = document.createElement('h3')
  otherHeading.style.fontFamily = 'var(--mono)'
  otherHeading.style.fontSize = '13px'
  otherHeading.style.margin = '0 0 6px 0'
  otherHeading.textContent = 'Other views'
  const startCreationBtn = document.createElement('button')
  startCreationBtn.textContent = 'Start character creation (owner)'
  const hierarchyBtn = document.createElement('button')
  hierarchyBtn.textContent = 'View entity hierarchy'
  hierarchyBtn.style.marginLeft = '8px'
  const tablesBtn = document.createElement('button')
  tablesBtn.textContent = 'View random tables'
  tablesBtn.style.marginLeft = '8px'
  const archiveBtn = document.createElement('button')
  archiveBtn.textContent = 'Archive campaign (owner)'
  archiveBtn.style.marginLeft = '8px'
  other.appendChild(otherHeading)
  other.appendChild(startCreationBtn)
  other.appendChild(hierarchyBtn)
  other.appendChild(tablesBtn)
  other.appendChild(archiveBtn)

  const detail = document.createElement('pre')
  detail.className = 'result'
  detail.setAttribute('data-region', 'detail')
  detail.style.marginTop = '12px'
  detail.style.whiteSpace = 'pre-wrap'
  detail.style.maxHeight = '320px'
  detail.style.overflowY = 'auto'
  detail.textContent = '(click "View entity hierarchy", "View random tables", or a roster "view" link to inspect JSON here)'

  card.appendChild(title)
  card.appendChild(status)
  card.appendChild(situations)
  card.appendChild(roster)
  card.appendChild(form)
  card.appendChild(other)
  card.appendChild(detail)

  return {
    card, status, situations, roster, form, other,
    conceptInput, groundingInput, submitBtn,
    archiveBtn, hierarchyBtn, tablesBtn, startCreationBtn, detail,
  }
}

// ---- Sub-renderers ----

function renderSituations(
  el: HTMLElement,
  data: SituationsResponse | { code: 'world_not_ready' } | null,
  onPick: (index: number) => void,
): void {
  el.replaceChildren()
  const heading = document.createElement('h3')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '13px'
  heading.style.margin = '0 0 6px 0'
  heading.textContent = 'Starting situation (owner picks one)'
  el.appendChild(heading)
  if (data === null) {
    const msg = document.createElement('div')
    msg.className = 'result'
    msg.textContent = '(no situations loaded)'
    el.appendChild(msg)
    return
  }
  if ('code' in data) {
    const msg = document.createElement('div')
    msg.className = 'result'
    msg.textContent = '404 world_not_ready — starting_situation_entries empty (world gen still running?)'
    el.appendChild(msg)
    return
  }
  const list = document.createElement('ol')
  list.style.fontFamily = 'var(--mono)'
  list.style.fontSize = '12px'
  list.style.paddingLeft = '20px'
  data.situations.forEach((s) => {
    const item = document.createElement('li')
    item.style.marginBottom = '6px'
    const proseEl = document.createElement('div')
    proseEl.style.whiteSpace = 'pre-wrap'
    // textContent — situation prose is LLM-authored.
    proseEl.textContent = s.prose
    item.appendChild(proseEl)
    const pickBtn = document.createElement('button')
    const picked = data.chosenIndex === s.index
    pickBtn.textContent = picked ? `Picked (index ${String(s.index)})` : `Pick (index ${String(s.index)})`
    pickBtn.disabled = picked
    pickBtn.style.marginTop = '4px'
    pickBtn.addEventListener('click', () => {
      onPick(s.index)
    })
    item.appendChild(pickBtn)
    list.appendChild(item)
  })
  el.appendChild(list)
}

function renderRoster(
  el: HTMLElement,
  roster: RosterResponse,
  onView: (charId: string) => void,
): void {
  el.replaceChildren()
  const heading = document.createElement('h3')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '13px'
  heading.style.margin = '0 0 6px 0'
  heading.textContent = `Roster (${String(roster.members.length)} member${roster.members.length === 1 ? '' : 's'})`
  el.appendChild(heading)
  if (roster.members.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'result'
    msg.textContent = '(no members)'
    el.appendChild(msg)
    return
  }
  const ul = document.createElement('ul')
  ul.style.fontFamily = 'var(--mono)'
  ul.style.fontSize = '12px'
  ul.style.paddingLeft = '20px'
  ul.style.margin = '0'
  roster.members.forEach((m) => {
    const li = document.createElement('li')
    const nameEl = document.createElement('strong')
    // textContent — displayName is user-provided.
    nameEl.textContent = m.displayName
    li.appendChild(nameEl)
    const statusEl = document.createElement('span')
    statusEl.style.color = 'var(--fg-muted)'
    statusEl.textContent = `  status=${m.conceptStatus}  userId=${m.userId}`
    li.appendChild(statusEl)
    if (m.characterId !== undefined) {
      const sep = document.createTextNode('  ')
      li.appendChild(sep)
      const viewBtn = document.createElement('button')
      viewBtn.textContent = 'view'
      const charId = m.characterId
      viewBtn.addEventListener('click', () => {
        onView(charId)
      })
      li.appendChild(viewBtn)
    }
    ul.appendChild(li)
  })
  el.appendChild(ul)
}

// ---- Mount ----

export function mountCharacterCreationPanel(parent: HTMLElement): void {
  const refs = buildView()
  parent.appendChild(refs.card)
  attachController(refs)
}

interface ControllerState {
  campaignId: string | null
  /** Token bumped on every refresh; stale responses (campaign switched
   *  mid-fetch) are dropped via the same trick world-snapshot uses. */
  fetchToken: number
}

function setState(card: HTMLElement, s: 'idle' | 'loading' | 'ready' | 'error'): void {
  card.setAttribute('data-state', s)
}

function writeDetail(detail: HTMLElement, label: string, status: number, body: unknown): void {
  // textContent on a pre — stringified JSON is safe to display but we
  // never inject HTML.
  detail.textContent = `${label} → ${String(status)}\n\n${JSON.stringify(body, null, 2)}`
}

// eslint-disable-next-line max-lines-per-function
function attachController(refs: ViewRefs): void {
  const state: ControllerState = { campaignId: null, fetchToken: 0 }

  async function refresh(): Promise<void> {
    if (state.campaignId === null) {
      refs.status.textContent = '(no campaign watched — click Watch on a campaign)'
      refs.situations.replaceChildren()
      refs.roster.replaceChildren()
      setState(refs.card, 'idle')
      return
    }
    const campaignId = state.campaignId
    state.fetchToken += 1
    const token = state.fetchToken
    setState(refs.card, 'loading')
    refs.status.textContent = `loading ${campaignId}...`

    const [situationsRes, rosterRes] = await Promise.all([
      apiCall<SituationsResponse | ErrorEnvelope>(
        `/api/campaigns/${campaignId}/starting-situations`,
      ),
      apiCall<RosterResponse>(`/api/campaigns/${campaignId}/characters`),
    ])
    if (token !== state.fetchToken) return

    // Situations: 200 → render list; 404 world_not_ready → render inline
    // explanation but stay 'ready' overall (roster may still be useful).
    let situationsForRender: SituationsResponse | { code: 'world_not_ready' } | null
    if (situationsRes.status === 200 && situationsRes.body !== null && 'situations' in situationsRes.body) {
      situationsForRender = situationsRes.body
    } else if (situationsRes.status === 404) {
      situationsForRender = { code: 'world_not_ready' }
    } else {
      situationsForRender = null
    }

    if (rosterRes.status !== 200 || rosterRes.body === null) {
      refs.status.textContent = `roster error ${String(rosterRes.status)}: ${rosterRes.error ?? JSON.stringify(rosterRes.body)}`
      setState(refs.card, 'error')
      return
    }

    renderSituations(refs.situations, situationsForRender, (idx) => {
      void pickSituation(campaignId, idx)
    })
    renderRoster(refs.roster, rosterRes.body, (charId) => {
      void viewCharacter(campaignId, charId)
    })
    refs.status.textContent = `loaded ${campaignId}  (members=${String(rosterRes.body.members.length)})`
    setState(refs.card, 'ready')
  }

  async function pickSituation(campaignId: string, index: number): Promise<void> {
    const res = await apiCall<{ index: number } | ErrorEnvelope>(
      `/api/campaigns/${campaignId}/starting-situation`,
      { method: 'POST', body: JSON.stringify({ index }) },
    )
    writeDetail(refs.detail, `POST /starting-situation (index=${String(index)})`, res.status, res.body)
    await refresh()
  }

  async function startCharacterCreation(campaignId: string): Promise<void> {
    const res = await apiCall(
      `/api/campaigns/${campaignId}/start-character-creation`,
      { method: 'POST' },
    )
    writeDetail(refs.detail, 'POST /start-character-creation', res.status, res.body)
    await refresh()
  }

  async function submitCharacter(campaignId: string): Promise<void> {
    const conceptText = refs.conceptInput.value
    const situationGroundingText = refs.groundingInput.value
    const body: Record<string, unknown> = { situationGroundingText }
    if (conceptText.length > 0) body.conceptText = conceptText
    const res = await apiCall<{ conceptId: string; status: string } | ErrorEnvelope>(
      `/api/campaigns/${campaignId}/characters`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    writeDetail(refs.detail, 'POST /characters', res.status, res.body)
    await refresh()
  }

  async function viewCharacter(campaignId: string, charId: string): Promise<void> {
    const res = await apiCall(`/api/campaigns/${campaignId}/characters/${charId}`)
    writeDetail(refs.detail, `GET /characters/${charId}`, res.status, res.body)
  }

  async function viewHierarchy(campaignId: string): Promise<void> {
    const res = await apiCall(`/api/campaigns/${campaignId}/hierarchy`)
    writeDetail(refs.detail, 'GET /hierarchy', res.status, res.body)
  }

  async function viewRandomTables(campaignId: string): Promise<void> {
    const res = await apiCall(`/api/campaigns/${campaignId}/random-tables`)
    writeDetail(refs.detail, 'GET /random-tables', res.status, res.body)
  }

  async function archiveCampaign(campaignId: string): Promise<void> {
    const res = await apiCall(
      `/api/campaigns/${campaignId}/archive`,
      { method: 'POST' },
    )
    writeDetail(refs.detail, 'POST /archive', res.status, res.body)
    await refresh()
  }

  // ---- Wire buttons ----
  refs.submitBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void submitCharacter(state.campaignId)
  })
  refs.startCreationBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void startCharacterCreation(state.campaignId)
  })
  refs.archiveBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void archiveCampaign(state.campaignId)
  })
  refs.hierarchyBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void viewHierarchy(state.campaignId)
  })
  refs.tablesBtn.addEventListener('click', () => {
    if (state.campaignId !== null) void viewRandomTables(state.campaignId)
  })

  // ---- External events ----
  window.addEventListener('mythrun.watchcampaign', (e) => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id !== 'string' || id.length === 0) return
    state.campaignId = id
    void refresh()
  })
  window.addEventListener('mythrun.closewatch', () => {
    state.campaignId = null
    state.fetchToken += 1
    refs.conceptInput.value = ''
    refs.groundingInput.value = ''
    refs.detail.textContent = '(click "View entity hierarchy", "View random tables", or a roster "view" link to inspect JSON here)'
    void refresh()
  })
}
