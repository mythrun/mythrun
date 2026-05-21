// MYT-51 T13 — campaign-details-panel.
//
// Renders `GET /api/campaigns/:campaignId` — the campaign row, the
// embedded world (with stage outputs as they land), and the member list.
// A Resume button surfaces when the campaign's status reads as
// `world_gen_failed` (the only resumable terminal phase wired in this
// ticket); clicking it calls POST /api/campaigns/:campaignId/resume and
// renders the discriminated response code per spec § "POST /api/campaigns/
// :id/resume flow":
//
//   202 + action                              → "re-enqueued"
//   409 world_gen_in_progress                 → user-visible state msg
//   409 phase_not_yet_implementable           → stuckAtStage rendering
//   409 world_gen_capped                      → cost-cap message
//   409 nothing_to_resume / already_complete / terminal_failure
//                                              → same shape, code rendered
//   422 phase_resume_not_yet_implemented      → phase rendering
//
// All server-returned string fields go through textContent (Roc-C2).

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import type { PanelHandle } from './_shared/panel-skeleton.js'

interface Campaign {
  readonly id: string
  readonly worldId: string
  readonly name: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface World {
  readonly id: string
  readonly name: string
  readonly concept: string
  readonly status: 'generating' | 'complete' | 'failed'
  readonly tone: string | null
  readonly themes: string | null
  readonly geographySummary: string | null
  readonly politicalSummary: string | null
  readonly era: string | null
  readonly keyTensions: string | null
  readonly worldOverview: string | null
  readonly followUpQuestions: string | null
  readonly startingSituations: string | null
}

interface Member {
  readonly id: string
  readonly userId: string
  readonly role: 'owner' | 'player'
  readonly inviteAccepted: boolean
  readonly joinedAt: string
}

interface DetailsResponse {
  readonly campaign: Campaign
  readonly world: World
  readonly members: readonly Member[]
}

interface StatusResponse {
  readonly phase: string
}

interface ResumeResponse {
  readonly code?: string
  readonly action?: string
  readonly stuckAtStage?: string
  readonly phase?: string
  readonly campaignId?: string
}

function addField(parent: HTMLElement, label: string, value: string | null): void {
  if (value === null || value.length === 0) return
  const row = document.createElement('div')
  row.style.marginBottom = '6px'
  const k = document.createElement('span')
  k.style.color = 'var(--fg-muted)'
  k.style.fontFamily = 'var(--mono)'
  k.style.fontSize = '12px'
  k.textContent = `${label}: `
  const v = document.createElement('span')
  v.style.whiteSpace = 'pre-wrap'
  // textContent — world fields contain LLM-authored prose (Roc-C2).
  v.textContent = value
  row.appendChild(k)
  row.appendChild(v)
  parent.appendChild(row)
}

function renderWorld(parent: HTMLElement, world: World): void {
  const heading = document.createElement('h3')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '13px'
  heading.style.margin = '12px 0 6px 0'
  heading.textContent = `world: ${world.name} (${world.status})`
  parent.appendChild(heading)
  addField(parent, 'concept', world.concept)
  addField(parent, 'tone', world.tone)
  addField(parent, 'themes', world.themes)
  addField(parent, 'era', world.era)
  addField(parent, 'geographySummary', world.geographySummary)
  addField(parent, 'politicalSummary', world.politicalSummary)
  addField(parent, 'keyTensions', world.keyTensions)
  addField(parent, 'worldOverview', world.worldOverview)
  addField(parent, 'followUpQuestions', world.followUpQuestions)
  addField(parent, 'startingSituations', world.startingSituations)
}

function renderMembers(parent: HTMLElement, members: readonly Member[]): void {
  const heading = document.createElement('h3')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '13px'
  heading.style.margin = '12px 0 6px 0'
  heading.textContent = `members (${String(members.length)})`
  parent.appendChild(heading)
  const list = document.createElement('pre')
  list.style.whiteSpace = 'pre-wrap'
  list.style.fontFamily = 'var(--mono)'
  list.style.fontSize = '12px'
  list.style.margin = '0'
  list.textContent = members
    .map((m) => `${m.role.padEnd(8)} ${m.userId} accepted=${String(m.inviteAccepted)}`)
    .join('\n')
  parent.appendChild(list)
}

interface DomRefs {
  readonly card: HTMLElement
  readonly title: HTMLElement
  readonly input: HTMLInputElement
  readonly fetchBtn: HTMLButtonElement
  readonly resumeBtn: HTMLButtonElement
  readonly inputRow: HTMLElement
  readonly status: HTMLElement
  readonly body: HTMLElement
  readonly resumeStatus: HTMLElement
  readonly renameInput: HTMLInputElement
  readonly renameBtn: HTMLButtonElement
  readonly renameRow: HTMLElement
  readonly renameStatus: HTMLElement
}

function buildDom(): DomRefs {
  const card = document.createElement('section')
  card.className = 'card'
  // Event-driven panel: form on mount, fetches only on click or
  // mythrun.opendetails. data-state="idle" is the verify harness's
  // steady-state marker.
  card.setAttribute('data-state', 'idle')

  const title = document.createElement('h2')
  title.textContent = 'GET /api/campaigns/:campaignId (details)'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '320px'

  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'Fetch'

  const resumeBtn = document.createElement('button')
  resumeBtn.textContent = 'Resume'
  resumeBtn.style.display = 'none'
  resumeBtn.style.marginLeft = '8px'

  const inputRow = document.createElement('div')
  inputRow.style.display = 'flex'
  inputRow.style.gap = '8px'
  inputRow.style.marginBottom = '12px'
  inputRow.appendChild(input)
  inputRow.appendChild(fetchBtn)
  inputRow.appendChild(resumeBtn)

  const status = document.createElement('div')
  status.className = 'result'
  status.textContent = '(no campaign loaded)'

  const body = document.createElement('div')

  const resumeStatus = document.createElement('div')
  resumeStatus.className = 'result'

  // myth-4lhr: rename row. Hidden until a campaign is loaded; PATCHes
  // /api/campaigns/:id/name on submit.
  const renameInput = document.createElement('input')
  renameInput.type = 'text'
  renameInput.placeholder = 'new campaign name'
  renameInput.style.width = '320px'
  const renameBtn = document.createElement('button')
  renameBtn.textContent = 'Rename'
  renameBtn.style.marginLeft = '8px'
  const renameRow = document.createElement('div')
  renameRow.style.display = 'none'
  renameRow.style.marginTop = '12px'
  renameRow.appendChild(renameInput)
  renameRow.appendChild(renameBtn)
  const renameStatus = document.createElement('div')
  renameStatus.className = 'result'

  return {
    card, title, input, fetchBtn, resumeBtn, inputRow, status, body, resumeStatus,
    renameInput, renameBtn, renameRow, renameStatus,
  }
}

export function mountCampaignDetailsPanel(parent: HTMLElement): PanelHandle {
  const dom = buildDom()
  const {
    card, title, input, fetchBtn, resumeBtn, inputRow, status, body, resumeStatus,
    renameInput, renameBtn, renameRow, renameStatus,
  } = dom

  // Resume visibility depends on the current campaign's phase. We hit
  // /status to derive it (a single SSE-less read) right after /details,
  // since `world.status` alone doesn't disambiguate "still generating"
  // from "failed mid-pipeline" — derivePhase reads pipeline_runs.
  let currentCampaignId: string | null = null

  async function fetchDetails(): Promise<void> {
    const id = input.value.trim()
    if (id.length === 0) return
    currentCampaignId = id
    status.textContent = 'loading...'
    body.replaceChildren()
    resumeBtn.style.display = 'none'
    resumeStatus.textContent = ''

    const res = await apiCall<DetailsResponse>(`/api/campaigns/${id}`)
    if (res.status !== 200 || res.body === null) {
      status.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
      return
    }

    const data = res.body
    status.textContent = `campaign: ${data.campaign.name} (status=${data.campaign.status})`
    renderWorld(body, data.world)
    renderMembers(body, data.members)
    // myth-4lhr: show the rename row once a campaign is loaded; preload
    // the current name so the user can edit-in-place.
    renameInput.value = data.campaign.name
    renameRow.style.display = 'block'
    renameStatus.textContent = ''

    // Resume gating — surface the button only when phase reads
    // world_gen_failed. Other terminal phases (failed, complete) the
    // button stays hidden; in-progress phases use the status panel.
    const statusRes = await apiCall<StatusResponse>(`/api/campaigns/${id}/status`)
    if (statusRes.status === 200 && statusRes.body !== null) {
      if (statusRes.body.phase === 'world_gen_failed') {
        resumeBtn.style.display = 'inline-block'
      }
    }
  }

  async function resume(): Promise<void> {
    if (currentCampaignId === null) return
    resumeBtn.disabled = true
    resumeStatus.textContent = 'resuming...'
    const res = await apiCall<ResumeResponse>(`/api/campaigns/${currentCampaignId}/resume`, {
      method: 'POST',
    })
    const respBody = res.body ?? {}
    const code = respBody.code ?? '(no code)'
    if (res.status === 202) {
      resumeStatus.textContent = `202 ${respBody.action ?? 're-enqueued'}`
    } else if (res.status === 409 && code === 'phase_not_yet_implementable') {
      resumeStatus.textContent = `409 phase_not_yet_implementable (stuck at ${
        respBody.stuckAtStage ?? 'unknown'
      })`
    } else if (res.status === 422 && code === 'phase_resume_not_yet_implemented') {
      resumeStatus.textContent = `422 phase_resume_not_yet_implemented (phase=${
        respBody.phase ?? 'unknown'
      })`
    } else {
      resumeStatus.textContent = `${String(res.status)} ${code}`
    }
    resumeBtn.disabled = false
  }

  async function rename(): Promise<void> {
    if (currentCampaignId === null) return
    const newName = renameInput.value.trim()
    if (newName.length === 0) {
      renameStatus.textContent = 'name is required'
      return
    }
    renameBtn.disabled = true
    renameStatus.textContent = 'renaming...'
    const res = await apiCall<{ campaignId: string; name: string }>(
      `/api/campaigns/${currentCampaignId}/name`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      },
    )
    if (res.status === 200 && res.body !== null) {
      renameStatus.textContent = `renamed to: ${res.body.name}`
      // Reflect the new name in the status line.
      status.textContent = status.textContent.replace(/^campaign: [^(]+/, `campaign: ${res.body.name} `)
    } else {
      renameStatus.textContent = `${String(res.status)} ${res.error ?? JSON.stringify(res.body)}`
    }
    renameBtn.disabled = false
  }

  fetchBtn.addEventListener('click', () => {
    void fetchDetails()
  })
  resumeBtn.addEventListener('click', () => {
    void resume()
  })
  renameBtn.addEventListener('click', () => {
    void rename()
  })

  // External clear hook (identity switch).
  const onClear = (): void => {
    input.value = ''
    currentCampaignId = null
    status.textContent = '(no campaign loaded)'
    body.replaceChildren()
    resumeStatus.textContent = ''
    resumeBtn.style.display = 'none'
    renameInput.value = ''
    renameRow.style.display = 'none'
    renameStatus.textContent = ''
  }
  window.addEventListener('mythrun.detailspanel.clear', onClear)

  // External open hook (dispatched by my-campaigns-panel's Details button).
  // Drop the campaignId into the input + fetch.
  const onOpenDetails = (e: Event): void => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id !== 'string' || id.length === 0) return
    input.value = id
    void fetchDetails()
  }
  window.addEventListener('mythrun.opendetails', onOpenDetails)

  card.appendChild(title)
  card.appendChild(inputRow)
  card.appendChild(status)
  card.appendChild(body)
  card.appendChild(resumeStatus)
  card.appendChild(renameRow)
  card.appendChild(renameStatus)
  parent.appendChild(card)

  // Preload the active campaign id (if any) so the operator doesn't have
  // to paste it again when navigating in from My campaigns.
  const initialActive = getActiveCampaignId()
  if (initialActive !== null) {
    input.value = initialActive
  }

  return {
    root: card,
    unmount: () => {
      window.removeEventListener('mythrun.detailspanel.clear', onClear)
      window.removeEventListener('mythrun.opendetails', onOpenDetails)
      if (card.parentNode !== null) card.parentNode.removeChild(card)
    },
  }
}

registerPanelMount('GET', '/api/campaigns/:campaignId', mountCampaignDetailsPanel)
