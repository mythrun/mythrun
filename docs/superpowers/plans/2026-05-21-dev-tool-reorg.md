# Dev Tool Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dev tool's 14-panel single-vertical-scroll layout with a sidebar-shell-plus-wire-log-drawer architecture, dark-mode-default, endpoint-per-panel, on-brand with the wiki.

**Architecture:** A persistent shell (header + banner + sidebar + main pane + right-side wire-log drawer) hosts ~30 endpoint × action panels. Each panel is a split-view: action on the left, feedback on the right. The drawer owns one `EventSource` per subscribed campaign and publishes events to an in-process bus that long-running panel feedback panes subscribe to. Active-campaign state is a single global in localStorage; sidebar leaves that need `:campaignId` dim when there's no active campaign.

**Tech Stack:** TypeScript strict, vanilla DOM (no framework), Vite, JSDOM for tests. Palette tokens from `docs/wiki/site/styles.css` inverted for dark default. IBM Plex Mono everywhere.

**Bead:** myth-mbdc.

**Spec:** `docs/superpowers/specs/2026-05-21-dev-tool-reorg-design.md` — read end-to-end before implementing.

---

## File Structure

**New files** (under `backend/dev-tool/src/`):

```
shell/
├── shell.ts                     # composition root: header + banner + sidebar + main + drawer
├── identity-bridge.ts           # mythrun.identitychanged listener; unmount + re-mount + active-campaign + drawer re-sub
├── banner.ts                    # active-campaign banner; subscribes to drawer bus + polls /health/ready
├── sidebar.ts                   # endpoint × action leaves; selected state; persistence
├── active-campaign.ts           # global state: activeCampaignId in localStorage + subscribers
├── route-registry.ts            # imports BACKEND_ROUTES; declares per-route panel mapping; asserts coverage invariant
├── route-registry-invariant.ts  # runtime + test assertion: every BACKEND_ROUTES entry has a home OR is exempt
└── drawer/
    ├── drawer.ts                # UI: collapsible right pane, filter, pause/clear/export
    ├── subscriptions.ts         # EventSource lifecycle per campaign; multi-campaign aggregation
    ├── event-bus.ts             # in-process pub/sub: drawer publishes, panels subscribe
    └── buffer.ts                # 500-event ring buffer + FIFO eviction
shell/__tests__/
├── active-campaign.test.ts
├── route-registry.test.ts       # invariant: every BACKEND_ROUTES entry covered
├── identity-bridge.test.ts
├── drawer-subscriptions.test.ts
├── drawer-buffer.test.ts
└── shell.test.ts                # composition + lazy-mount + sidebar-selection routing
components/_shared/
├── panel-skeleton.ts            # buildSplitView({title, action, feedback}) → {root, actionEl, feedbackEl, setState}
├── json-disclosure.ts           # collapsed raw-json viewer
├── error-block.ts               # danger-500 error renderer
├── progress-strip.ts            # stage progress bar (for long-running panels)
└── __tests__/
    ├── panel-skeleton.test.ts
    ├── json-disclosure.test.ts
    ├── error-block.test.ts
    └── progress-strip.test.ts
```

**Modified files:**

- `backend/dev-tool/src/main.ts` — rewritten to mount the shell, not panels directly.
- `backend/dev-tool/src/styles.css` — rewritten against the dark palette + IBM Plex Mono.
- `backend/dev-tool/index.html` — adds the IBM Plex Mono `<link>` tag + sets `data-theme="dark"` on `<html>`.
- `backend/dev-tool/verify-registry.ts` — updated entries for refactored panels + new panels for previously-omitted routes.
- `backend/dev-tool/src/components/*.ts` — each existing panel refactored to (a) use `_shared/panel-skeleton` for the split-view DOM, (b) export both `mount(parent)` AND a `PanelHandle` with `unmount()`, (c) subscribe to the drawer event bus for long-running panels instead of opening its own `EventSource`.
- New panel files in `components/` for previously-missing routes (delete-campaign, patch-name, resume, starting-situation, members, invite-preview, invite-delete, credit-me, billing-skus/subscription/balance/history/portal/upgrade-tier).

---

## Phase 1 — Palette + base styles

### Task 1: Define the dark-mode CSS tokens

**Files:**
- Modify: `backend/dev-tool/src/styles.css`
- Modify: `backend/dev-tool/index.html`

- [ ] **Step 1: Add the IBM Plex Mono link to index.html**

Replace `<head>` in `backend/dev-tool/index.html` with:

```html
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mythrun dev tool</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
```

Also change `<html lang="en">` to `<html lang="en" data-theme="dark">`.

- [ ] **Step 2: Rewrite styles.css with the dark palette tokens**

Replace `backend/dev-tool/src/styles.css` entirely with:

```css
:root {
  /* Backgrounds — darkest is page; ramp up for chrome */
  --bg-page:     #231b12; /* paper-900 */
  --bg-elevated: #1a130a; /* one step darker than 900 */
  --bg-banner:   #3d3528; /* paper-700 */

  /* Type */
  --fg-emphasis: #f7f3e9; /* paper-50 */
  --fg-default:  #c9c0ad; /* paper-300 */
  --fg-muted:    #877f72; /* paper-500 */

  /* Borders */
  --border-strong: #625a4d; /* paper-600 */
  --border-soft:   #3d3528; /* paper-700 */

  /* Accents */
  --accent:        #8a5a3c; /* ember-600 */
  --danger:        #b55a48; /* danger-500 */
  --ok:            #6a8a3c;

  /* Type families */
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--fg-default);
  background: var(--bg-page);
  line-height: 1.5;
}

button {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--accent);
  color: var(--fg-emphasis);
  border: 0;
  padding: 4px 10px;
  cursor: pointer;
}
button:hover { filter: brightness(1.15); }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.secondary {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--fg-default);
}

input, textarea, select {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-elevated);
  color: var(--fg-default);
  border: 1px solid var(--border-soft);
  padding: 4px 6px;
}
input:focus, textarea:focus, select:focus {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.label-small {
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--fg-muted);
}
```

- [ ] **Step 3: Open the dev tool in a browser**

Run: `cd backend && pnpm dev:raw &` (background) — wait until backend prints `Server listening`.

In another terminal: `cd backend/dev-tool && pnpm dev &` (Vite).

Open `http://localhost:5173`. Expected: the page is dark (paper-900 background), text is paper-300 monospace IBM Plex Mono, but the existing panels still render their light-mode whitebox `card` divs (those classes are still defined in styles.css's lower half — we'll rewrite them in subsequent tasks). This intermediate state is expected; we're shipping per task.

Note: at this point existing panels will look broken. That's fine — Phase 5 fixes them.

- [ ] **Step 4: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/dev-tool/index.html backend/dev-tool/src/styles.css
git commit -m "feat(dev-tool): dark-mode palette tokens + IBM Plex Mono (myth-mbdc P1)

First step of the dev-tool reorg. Replaces the light-mode tokens
(--fg #1a1a1a, --bg #fafaf7, white cards) with the wiki paper palette
inverted: paper-900 page bg, paper-300 default text, paper-50 emphasis,
ember-600 accent, danger-500 for failure. IBM Plex Mono loaded via
Google Fonts preconnect.

Existing panels render unstyled cards against the new bg; subsequent
phases swap each panel to the new skeleton."
```

---

## Phase 2 — Shared helpers (`_shared/`)

### Task 2: Panel skeleton (split-view DOM builder)

**Files:**
- Create: `backend/dev-tool/src/components/_shared/panel-skeleton.ts`
- Create: `backend/dev-tool/src/components/_shared/__tests__/panel-skeleton.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/dev-tool/src/components/_shared/__tests__/panel-skeleton.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildSplitView } from '../panel-skeleton.js'

function makeParent(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const parent = dom.window.document.getElementById('root')
  if (parent === null) throw new Error('test setup: missing root')
  return parent
}

describe('panel-skeleton.buildSplitView', () => {
  it('builds a root element with title, action, and feedback regions', () => {
    const parent = makeParent()
    const { root, actionEl, feedbackEl } = buildSplitView({
      parent,
      title: 'POST /api/campaigns',
    })
    expect(root.getAttribute('data-state')).toBe('idle')
    expect(root.querySelector('h1')?.textContent).toBe('POST /api/campaigns')
    expect(actionEl.getAttribute('data-region')).toBe('action')
    expect(feedbackEl.getAttribute('data-region')).toBe('feedback')
    expect(parent.contains(root)).toBe(true)
  })

  it('setState updates the root data-state attribute', () => {
    const parent = makeParent()
    const { root, setState } = buildSplitView({ parent, title: 't' })
    setState('loading')
    expect(root.getAttribute('data-state')).toBe('loading')
    setState('ready')
    expect(root.getAttribute('data-state')).toBe('ready')
    setState('error')
    expect(root.getAttribute('data-state')).toBe('error')
  })
})
```

- [ ] **Step 2: Run the tests — confirm FAIL**

```
cd backend && pnpm vitest run dev-tool/src/components/_shared/__tests__/panel-skeleton.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement panel-skeleton.ts**

```typescript
// backend/dev-tool/src/components/_shared/panel-skeleton.ts
//
// myth-mbdc: split-view DOM builder shared by every endpoint × action
// panel. Builds the standard skeleton (title + two-pane action/feedback
// region) and returns handles for the panel implementation to fill in.

export type PanelState = 'idle' | 'loading' | 'ready' | 'error'

export interface SplitViewOpts {
  readonly parent: HTMLElement
  readonly title: string
}

export interface SplitViewHandles {
  readonly root: HTMLElement
  readonly actionEl: HTMLElement
  readonly feedbackEl: HTMLElement
  setState(state: PanelState): void
}

export function buildSplitView(opts: SplitViewOpts): SplitViewHandles {
  const root = document.createElement('section')
  root.setAttribute('data-state', 'idle')
  root.style.padding = '12px 16px'
  root.style.background = 'var(--bg-page)'
  root.style.color = 'var(--fg-default)'

  const titleEl = document.createElement('h1')
  titleEl.style.fontFamily = 'var(--mono)'
  titleEl.style.fontSize = '14px'
  titleEl.style.fontWeight = '500'
  titleEl.style.color = 'var(--fg-emphasis)'
  titleEl.style.margin = '0 0 8px 0'
  titleEl.textContent = opts.title
  root.appendChild(titleEl)

  const splitWrap = document.createElement('div')
  splitWrap.style.display = 'flex'
  splitWrap.style.gap = '12px'

  const actionEl = document.createElement('div')
  actionEl.setAttribute('data-region', 'action')
  actionEl.style.flex = '0 0 38%'
  actionEl.style.borderRight = '1px solid var(--border-soft)'
  actionEl.style.paddingRight = '12px'

  const feedbackEl = document.createElement('div')
  feedbackEl.setAttribute('data-region', 'feedback')
  feedbackEl.style.flex = '1'

  splitWrap.appendChild(actionEl)
  splitWrap.appendChild(feedbackEl)
  root.appendChild(splitWrap)

  opts.parent.appendChild(root)

  return {
    root,
    actionEl,
    feedbackEl,
    setState: (state: PanelState) => {
      root.setAttribute('data-state', state)
    },
  }
}
```

- [ ] **Step 4: Run the tests — confirm PASS**

```
cd backend && pnpm vitest run dev-tool/src/components/_shared/__tests__/panel-skeleton.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/_shared/panel-skeleton.ts backend/dev-tool/src/components/_shared/__tests__/panel-skeleton.test.ts
git commit -m "feat(dev-tool): panel-skeleton split-view DOM builder (myth-mbdc P2.1)"
```

### Task 3: Error block

**Files:**
- Create: `backend/dev-tool/src/components/_shared/error-block.ts`
- Create: `backend/dev-tool/src/components/_shared/__tests__/error-block.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/components/_shared/__tests__/error-block.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderErrorBlock } from '../error-block.js'

function makeContainer(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('error-block.renderErrorBlock', () => {
  it('renders status + code + message + optional raw disclosure', () => {
    const c = makeContainer()
    renderErrorBlock(c, {
      status: 403,
      code: 'forbidden',
      message: 'not a member of this campaign',
      raw: { detail: 'x' },
    })
    expect(c.textContent).toContain('403')
    expect(c.textContent).toContain('forbidden')
    expect(c.textContent).toContain('not a member of this campaign')
    const details = c.querySelector('details')
    expect(details).not.toBeNull()
  })

  it('omits the raw disclosure when raw is undefined', () => {
    const c = makeContainer()
    renderErrorBlock(c, { status: 500, code: 'internal', message: 'x' })
    expect(c.querySelector('details')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
cd backend && pnpm vitest run dev-tool/src/components/_shared/__tests__/error-block.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/components/_shared/error-block.ts
//
// Renders the canonical error block: status + code + message + optional
// collapsed raw response. Used in every panel's feedback pane.

export interface ErrorBlockOpts {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly raw?: unknown
}

export function renderErrorBlock(parent: HTMLElement, opts: ErrorBlockOpts): void {
  parent.replaceChildren()
  const block = document.createElement('div')
  block.style.borderLeft = '2px solid var(--danger)'
  block.style.padding = '6px 8px'
  block.style.background = 'var(--bg-elevated)'

  const line = document.createElement('div')
  line.style.color = 'var(--danger)'
  line.textContent = `${String(opts.status)} · ${opts.code}`
  block.appendChild(line)

  const msg = document.createElement('div')
  msg.style.color = 'var(--fg-default)'
  msg.style.marginTop = '2px'
  msg.textContent = opts.message
  block.appendChild(msg)

  if (opts.raw !== undefined) {
    const details = document.createElement('details')
    details.style.marginTop = '6px'
    const summary = document.createElement('summary')
    summary.textContent = 'raw response'
    summary.style.color = 'var(--fg-muted)'
    summary.style.fontSize = '10px'
    summary.style.cursor = 'pointer'
    const pre = document.createElement('pre')
    pre.style.fontSize = '10px'
    pre.style.background = 'rgba(0,0,0,0.2)'
    pre.style.padding = '4px'
    pre.style.margin = '4px 0 0 0'
    pre.textContent = JSON.stringify(opts.raw, null, 2)
    details.appendChild(summary)
    details.appendChild(pre)
    block.appendChild(details)
  }

  parent.appendChild(block)
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/_shared/error-block.ts backend/dev-tool/src/components/_shared/__tests__/error-block.test.ts
git commit -m "feat(dev-tool): shared error-block renderer (myth-mbdc P2.2)"
```

### Task 4: JSON disclosure

**Files:**
- Create: `backend/dev-tool/src/components/_shared/json-disclosure.ts`
- Create: `backend/dev-tool/src/components/_shared/__tests__/json-disclosure.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/components/_shared/__tests__/json-disclosure.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { appendJsonDisclosure } from '../json-disclosure.js'

function makeContainer(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('json-disclosure.appendJsonDisclosure', () => {
  it('appends a collapsed details element with the json string', () => {
    const c = makeContainer()
    appendJsonDisclosure(c, { foo: 'bar' })
    const d = c.querySelector('details')
    expect(d).not.toBeNull()
    expect(d?.hasAttribute('open')).toBe(false)
    expect(c.textContent).toContain('foo')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/components/_shared/json-disclosure.ts
//
// Collapsed raw-json viewer for panel feedback panes. Default-collapsed
// so the rendered structured view (list, detail card) is what the
// operator sees first; expand for the raw response.

export function appendJsonDisclosure(parent: HTMLElement, body: unknown): void {
  const details = document.createElement('details')
  details.style.marginTop = '8px'
  const summary = document.createElement('summary')
  summary.textContent = '▸ raw json'
  summary.style.color = 'var(--fg-muted)'
  summary.style.fontSize = '10px'
  summary.style.cursor = 'pointer'
  const pre = document.createElement('pre')
  pre.style.fontSize = '10px'
  pre.style.background = 'rgba(0,0,0,0.2)'
  pre.style.padding = '4px'
  pre.style.margin = '4px 0 0 0'
  pre.style.overflow = 'auto'
  pre.style.maxHeight = '300px'
  pre.textContent = JSON.stringify(body, null, 2)
  details.appendChild(summary)
  details.appendChild(pre)
  parent.appendChild(details)
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/_shared/json-disclosure.ts backend/dev-tool/src/components/_shared/__tests__/json-disclosure.test.ts
git commit -m "feat(dev-tool): shared json-disclosure (myth-mbdc P2.3)"
```

### Task 5: Progress strip

**Files:**
- Create: `backend/dev-tool/src/components/_shared/progress-strip.ts`
- Create: `backend/dev-tool/src/components/_shared/__tests__/progress-strip.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/components/_shared/__tests__/progress-strip.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { createProgressStrip } from '../progress-strip.js'

function makeC(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('progress-strip', () => {
  it('renders an empty (zero progress) strip on create', () => {
    const c = makeC()
    const strip = createProgressStrip(c, { total: 9 })
    expect(c.textContent).toContain('0/9')
    expect(strip.root.getAttribute('data-progress')).toBe('0')
  })

  it('update advances the rendered progress', () => {
    const c = makeC()
    const strip = createProgressStrip(c, { total: 9 })
    strip.update({ current: 4, label: 'entity_relationships' })
    expect(c.textContent).toContain('4/9')
    expect(c.textContent).toContain('entity_relationships')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/components/_shared/progress-strip.ts
//
// Stage progress visualization for long-running panels. Renders a
// label + n/total counter + a horizontal bar. Used by POST /api/campaigns,
// POST /start-character-creation, POST /characters.

export interface ProgressStripOpts {
  readonly total: number
}
export interface ProgressUpdate {
  readonly current: number
  readonly label: string
}
export interface ProgressStripHandle {
  readonly root: HTMLElement
  update(u: ProgressUpdate): void
}

export function createProgressStrip(
  parent: HTMLElement,
  opts: ProgressStripOpts,
): ProgressStripHandle {
  const root = document.createElement('div')
  root.setAttribute('data-progress', '0')
  root.style.margin = '6px 0'

  const labelEl = document.createElement('div')
  labelEl.style.fontSize = '11px'
  labelEl.style.color = 'var(--fg-emphasis)'
  labelEl.textContent = `0/${String(opts.total)}`
  root.appendChild(labelEl)

  const barWrap = document.createElement('div')
  barWrap.style.background = 'var(--bg-elevated)'
  barWrap.style.height = '6px'
  barWrap.style.marginTop = '3px'
  barWrap.style.border = '1px solid var(--border-soft)'
  const barFill = document.createElement('div')
  barFill.style.height = '100%'
  barFill.style.width = '0%'
  barFill.style.background = 'var(--accent)'
  barWrap.appendChild(barFill)
  root.appendChild(barWrap)

  parent.appendChild(root)

  return {
    root,
    update: ({ current, label }) => {
      const pct = Math.min(100, Math.round((current / opts.total) * 100))
      labelEl.textContent = `${String(current)}/${String(opts.total)}  ${label}`
      barFill.style.width = `${String(pct)}%`
      root.setAttribute('data-progress', String(pct))
    },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/_shared/progress-strip.ts backend/dev-tool/src/components/_shared/__tests__/progress-strip.test.ts
git commit -m "feat(dev-tool): shared progress-strip for long-running panels (myth-mbdc P2.4)"
```

---

## Phase 3 — Active campaign + route registry

### Task 6: Active-campaign module

**Files:**
- Create: `backend/dev-tool/src/shell/active-campaign.ts`
- Create: `backend/dev-tool/src/shell/__tests__/active-campaign.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/active-campaign.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getActiveCampaignId, setActiveCampaignId, onActiveCampaignChanged } from '../active-campaign.js'

describe('active-campaign', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing stored', () => {
    expect(getActiveCampaignId()).toBeNull()
  })

  it('set + get round-trips and notifies subscribers', () => {
    const cb = vi.fn()
    onActiveCampaignChanged(cb)
    setActiveCampaignId('019e-aaaa')
    expect(getActiveCampaignId()).toBe('019e-aaaa')
    expect(cb).toHaveBeenCalledWith('019e-aaaa')
  })

  it('setActiveCampaignId(null) clears the value', () => {
    setActiveCampaignId('019e-bbbb')
    setActiveCampaignId(null)
    expect(getActiveCampaignId()).toBeNull()
  })

  it('returns an unsubscribe fn that stops notifications', () => {
    const cb = vi.fn()
    const off = onActiveCampaignChanged(cb)
    setActiveCampaignId('1')
    off()
    setActiveCampaignId('2')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('1')
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
cd backend && pnpm vitest run dev-tool/src/shell/__tests__/active-campaign.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/active-campaign.ts
//
// Global single-source-of-truth for the active campaign id.
// Persists to localStorage; notifies subscribers on change.

const STORAGE_KEY = 'devtool.activeCampaignId'

const subscribers = new Set<(id: string | null) => void>()

export function getActiveCampaignId(): string | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === null || v === '' ? null : v
}

export function setActiveCampaignId(id: string | null): void {
  if (id === null) {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, id)
  }
  for (const cb of subscribers) {
    cb(id)
  }
}

export function onActiveCampaignChanged(cb: (id: string | null) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/active-campaign.ts backend/dev-tool/src/shell/__tests__/active-campaign.test.ts
git commit -m "feat(dev-tool): shell/active-campaign global state (myth-mbdc P3.1)"
```

### Task 7: Route registry with BACKEND_ROUTES invariant

**Files:**
- Create: `backend/dev-tool/src/shell/route-registry.ts`
- Create: `backend/dev-tool/src/shell/__tests__/route-registry.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/route-registry.test.ts
import { describe, it, expect } from 'vitest'
import { BACKEND_ROUTES } from '../../../../src/contract/backend-routes.js'
import { ROUTE_PANELS, EXEMPT_ROUTES } from '../route-registry.js'

describe('route-registry', () => {
  it('every BACKEND_ROUTES entry is either in ROUTE_PANELS or EXEMPT_ROUTES', () => {
    const covered = new Set<string>()
    for (const p of ROUTE_PANELS) {
      covered.add(`${p.method} ${p.path}`)
    }
    for (const r of EXEMPT_ROUTES) {
      covered.add(`${r.method} ${r.path}`)
    }
    const missing = BACKEND_ROUTES.filter((r) => !covered.has(`${r.method} ${r.path}`))
    expect(missing).toEqual([])
  })

  it('every ROUTE_PANELS entry references a real BACKEND_ROUTES route', () => {
    const real = new Set<string>(
      BACKEND_ROUTES.map((r) => `${r.method} ${r.path}`),
    )
    const stale = ROUTE_PANELS.filter((p) => !real.has(`${p.method} ${p.path}`))
    expect(stale).toEqual([])
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/route-registry.ts
//
// myth-mbdc: the sidebar's source of truth. Each entry maps one
// BACKEND_ROUTES route to a section + label + (later) a panel mount fn.
// The invariant test (__tests__/route-registry.test.ts) enforces
// coverage: every backend route is either here or in EXEMPT_ROUTES.

import type { BackendRoute } from '../../../src/contract/backend-routes.js'

export type SidebarSection = 'CAMPAIGNS' | 'WORLD' | 'CHARACTERS' | 'USERS' | 'BILLING' | 'SYSTEM'

export interface RoutePanel {
  readonly method: BackendRoute['method']
  readonly path: string
  readonly section: SidebarSection
  readonly label: string         // friendly secondary label e.g. "Roster"
  readonly requiresCampaign: boolean
  readonly longRunning: boolean  // true for endpoints that kick off async pipelines
}

export const EXEMPT_ROUTES: readonly BackendRoute[] = [
  // Webhook — Stripe-signed, no UI surface.
  { method: 'POST', path: '/webhooks/stripe' },
  // Register is exercised via the verifier's identity-bootstrap step;
  // embedded as a probe-helper inside the users panel rather than its
  // own sidebar leaf.
  { method: 'POST', path: '/api/users/register' },
  // Check-username is embedded inside register's panel (probe-helper).
  { method: 'GET', path: '/api/users/check-username' },
]

export const ROUTE_PANELS: readonly RoutePanel[] = [
  // CAMPAIGNS
  { method: 'POST',   path: '/api/campaigns',                                        section: 'CAMPAIGNS', label: 'Create',           requiresCampaign: false, longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/mine',                                   section: 'CAMPAIGNS', label: 'My campaigns',     requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId',                            section: 'CAMPAIGNS', label: 'Details',          requiresCampaign: true,  longRunning: false },
  { method: 'PATCH',  path: '/api/campaigns/:campaignId/name',                       section: 'CAMPAIGNS', label: 'Rename',           requiresCampaign: true,  longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/resume',                     section: 'CAMPAIGNS', label: 'Resume',           requiresCampaign: true,  longRunning: true  },
  { method: 'POST',   path: '/api/campaigns/:campaignId/archive',                    section: 'CAMPAIGNS', label: 'Archive',          requiresCampaign: true,  longRunning: false },
  { method: 'DELETE', path: '/api/campaigns/:campaignId',                            section: 'CAMPAIGNS', label: 'Delete',           requiresCampaign: true,  longRunning: false },

  // WORLD
  { method: 'GET',    path: '/api/campaigns/:campaignId/status',                     section: 'WORLD',     label: 'Status',           requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/status/stream',              section: 'WORLD',     label: 'Live events',      requiresCampaign: true,  longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/:campaignId/world-snapshot',             section: 'WORLD',     label: 'Snapshot',         requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/hierarchy',                  section: 'WORLD',     label: 'Hierarchy',        requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/random-tables',              section: 'WORLD',     label: 'Random tables',    requiresCampaign: true,  longRunning: false },

  // CHARACTERS
  { method: 'POST',   path: '/api/campaigns/:campaignId/start-character-creation',   section: 'CHARACTERS', label: 'Start (owner)',   requiresCampaign: true,  longRunning: true  },
  { method: 'POST',   path: '/api/campaigns/:campaignId/characters',                 section: 'CHARACTERS', label: 'Submit concept',  requiresCampaign: true,  longRunning: true  },
  { method: 'GET',    path: '/api/campaigns/:campaignId/characters',                 section: 'CHARACTERS', label: 'Roster',          requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/characters/:charId',         section: 'CHARACTERS', label: 'Character',       requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/starting-situations',        section: 'CHARACTERS', label: 'Situations (list)', requiresCampaign: true, longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/starting-situation',         section: 'CHARACTERS', label: 'Situation (pick)', requiresCampaign: true, longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/members',                    section: 'CHARACTERS', label: 'Members',         requiresCampaign: true,  longRunning: false },

  // USERS & ACCESS
  { method: 'GET',    path: '/api/users/me',                                         section: 'USERS',     label: 'Me',               requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/campaigns/:campaignId/invites',                    section: 'USERS',     label: 'Create invite',    requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/campaigns/:campaignId/invites',                    section: 'USERS',     label: 'List invites',     requiresCampaign: true,  longRunning: false },
  { method: 'DELETE', path: '/api/campaigns/:campaignId/invites/:inviteCode',        section: 'USERS',     label: 'Revoke invite',    requiresCampaign: true,  longRunning: false },
  { method: 'GET',    path: '/api/invites/:inviteCode/preview',                      section: 'USERS',     label: 'Preview invite',   requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/invites/:inviteCode/accept',                       section: 'USERS',     label: 'Accept invite',    requiresCampaign: false, longRunning: false },

  // BILLING & CREDITS
  { method: 'GET',    path: '/api/billing/skus',                                     section: 'BILLING',   label: 'SKUs',             requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/subscription',                             section: 'BILLING',   label: 'Subscription',     requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/balance',                                  section: 'BILLING',   label: 'Balance',          requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/billing/history',                                  section: 'BILLING',   label: 'History',          requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/checkout',                                 section: 'BILLING',   label: 'Checkout',         requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/portal',                                   section: 'BILLING',   label: 'Portal',           requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/billing/upgrade-tier',                             section: 'BILLING',   label: 'Upgrade tier',     requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/dev/credits/grant',                                section: 'BILLING',   label: 'Grant credits',    requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/api/dev/credits/me',                                   section: 'BILLING',   label: 'My credits',       requiresCampaign: false, longRunning: false },

  // SYSTEM
  { method: 'GET',    path: '/health',                                                section: 'SYSTEM',    label: 'Health',           requiresCampaign: false, longRunning: false },
  { method: 'GET',    path: '/health/ready',                                          section: 'SYSTEM',    label: 'Ready',            requiresCampaign: false, longRunning: false },
  { method: 'POST',   path: '/api/sessions/:id/ws-ticket',                            section: 'SYSTEM',    label: 'WS ticket',        requiresCampaign: false, longRunning: false },
]
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/route-registry.ts backend/dev-tool/src/shell/__tests__/route-registry.test.ts
git commit -m "feat(dev-tool): shell/route-registry with BACKEND_ROUTES invariant (myth-mbdc P3.2)"
```

---

## Phase 4 — Wire log drawer

### Task 8: Event bus

**Files:**
- Create: `backend/dev-tool/src/shell/drawer/event-bus.ts`
- Create: `backend/dev-tool/src/shell/drawer/__tests__/event-bus.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/drawer/__tests__/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '../event-bus.js'

interface E { campaignId: string; type: string; data: Record<string, unknown> }

describe('drawer event-bus', () => {
  it('publishes to all subscribers', () => {
    const bus = createEventBus<E>()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    const ev = { campaignId: 'c1', type: 'phase', data: { phase: 'world_gen' } }
    bus.publish(ev)
    expect(a).toHaveBeenCalledWith(ev)
    expect(b).toHaveBeenCalledWith(ev)
  })

  it('subscribe returns unsubscribe fn', () => {
    const bus = createEventBus<E>()
    const cb = vi.fn()
    const off = bus.subscribe(cb)
    bus.publish({ campaignId: 'c', type: 't', data: {} })
    off()
    bus.publish({ campaignId: 'c', type: 't', data: {} })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('publishes do not throw if a subscriber throws (other subs still get notified)', () => {
    const bus = createEventBus<E>()
    bus.subscribe(() => { throw new Error('boom') })
    const ok = vi.fn()
    bus.subscribe(ok)
    expect(() => bus.publish({ campaignId: 'c', type: 't', data: {} })).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/drawer/event-bus.ts
//
// myth-mbdc: in-process pub/sub. The drawer's EventSource lifecycle
// publishes here; long-running panel feedback panes subscribe (filtered
// to their own campaign id). One SSE socket per campaign; many readers.

export interface EventBus<T> {
  publish(event: T): void
  subscribe(cb: (event: T) => void): () => void
}

export function createEventBus<T>(): EventBus<T> {
  const subscribers = new Set<(event: T) => void>()
  return {
    publish: (event) => {
      for (const cb of subscribers) {
        try {
          cb(event)
        } catch {
          // a misbehaving subscriber must not prevent siblings from
          // receiving the event. Errors are swallowed; subscribers
          // should report their own diagnostic on throw.
        }
      }
    },
    subscribe: (cb) => {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/drawer/event-bus.ts backend/dev-tool/src/shell/drawer/__tests__/event-bus.test.ts
git commit -m "feat(dev-tool): drawer event-bus (myth-mbdc P4.1)"
```

### Task 9: Ring buffer

**Files:**
- Create: `backend/dev-tool/src/shell/drawer/buffer.ts`
- Create: `backend/dev-tool/src/shell/drawer/__tests__/buffer.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/drawer/__tests__/buffer.test.ts
import { describe, it, expect } from 'vitest'
import { createRingBuffer } from '../buffer.js'

describe('drawer ring buffer', () => {
  it('keeps the last N items; older items evict FIFO', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2); b.push(3); b.push(4)
    expect(b.items()).toEqual([2, 3, 4])
  })
  it('clear removes everything', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2)
    b.clear()
    expect(b.items()).toEqual([])
  })
  it('size reports current length', () => {
    const b = createRingBuffer<number>(3)
    b.push(1); b.push(2)
    expect(b.size()).toBe(2)
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/drawer/buffer.ts
//
// FIFO ring buffer for the drawer's 500-event in-memory log.

export interface RingBuffer<T> {
  push(item: T): void
  items(): readonly T[]
  size(): number
  clear(): void
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const buf: T[] = []
  return {
    push: (item) => {
      buf.push(item)
      while (buf.length > capacity) {
        buf.shift()
      }
    },
    items: () => buf.slice(),
    size: () => buf.length,
    clear: () => { buf.length = 0 },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/drawer/buffer.ts backend/dev-tool/src/shell/drawer/__tests__/buffer.test.ts
git commit -m "feat(dev-tool): drawer ring buffer (myth-mbdc P4.2)"
```

### Task 10: Subscription manager

**Files:**
- Create: `backend/dev-tool/src/shell/drawer/subscriptions.ts`
- Create: `backend/dev-tool/src/shell/drawer/__tests__/subscriptions.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/drawer/__tests__/subscriptions.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSubscriptionManager } from '../subscriptions.js'

// JSDOM has no real EventSource; we stub it.
interface FakeES {
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: Event) => void) | null
  close(): void
  readyState: number
  url: string
}
const opened: FakeES[] = []
class FakeEventSource implements FakeES {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0
  constructor(public url: string) { opened.push(this) }
  close(): void { this.readyState = 2 }
}

beforeEach(() => {
  opened.length = 0
  ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
})
afterEach(() => {
  // @ts-expect-error cleanup
  delete (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource
})

describe('drawer subscriptions', () => {
  it('subscribe opens an EventSource per campaign id and dedupes', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/api/campaigns/${id}/status/stream` })
    mgr.subscribe('cA')
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    expect(opened).toHaveLength(2)
    expect(opened[0]?.url).toContain('cA')
    expect(opened[1]?.url).toContain('cB')
  })

  it('unsubscribe closes the EventSource', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.unsubscribe('cA')
    expect(opened[0]?.readyState).toBe(2)
  })

  it('list returns the currently subscribed campaign ids', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    expect(mgr.list().sort()).toEqual(['cA', 'cB'])
  })

  it('onmessage parses payload and forwards to onEvent with campaign id', () => {
    const onEvent = vi.fn()
    const mgr = createSubscriptionManager({ onEvent, urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    const fake = opened[0]!
    fake.onmessage?.(new MessageEvent('message', { data: '{"type":"phase","data":{"phase":"world_gen"}}' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'cA', type: 'phase' }))
  })

  it('closeAll closes every subscription', () => {
    const mgr = createSubscriptionManager({ onEvent: vi.fn(), urlFor: (id) => `/x/${id}` })
    mgr.subscribe('cA')
    mgr.subscribe('cB')
    mgr.closeAll()
    expect(opened.every((o) => o.readyState === 2)).toBe(true)
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/drawer/subscriptions.ts
//
// myth-mbdc: EventSource lifecycle manager. One EventSource per
// subscribed campaign; the drawer owns these; long-running panels
// subscribe to the bus instead of opening their own.

export interface DrawerEvent {
  readonly campaignId: string
  readonly type: string
  readonly data: Record<string, unknown>
  readonly receivedAt: number
}

export interface SubscriptionManagerOpts {
  readonly onEvent: (event: DrawerEvent) => void
  readonly urlFor: (campaignId: string) => string
}

export interface SubscriptionManager {
  subscribe(campaignId: string): void
  unsubscribe(campaignId: string): void
  list(): readonly string[]
  closeAll(): void
}

export function createSubscriptionManager(opts: SubscriptionManagerOpts): SubscriptionManager {
  const open = new Map<string, EventSource>()

  function close(campaignId: string): void {
    const es = open.get(campaignId)
    if (es !== undefined) {
      es.close()
      open.delete(campaignId)
    }
  }

  return {
    subscribe: (campaignId) => {
      if (open.has(campaignId)) return
      const es = new EventSource(opts.urlFor(campaignId))
      es.onmessage = (e) => {
        try {
          const raw = JSON.parse(String(e.data)) as { type?: unknown; data?: unknown }
          const type = typeof raw.type === 'string' ? raw.type : 'unknown'
          const data = typeof raw.data === 'object' && raw.data !== null
            ? (raw.data as Record<string, unknown>)
            : {}
          opts.onEvent({ campaignId, type, data, receivedAt: Date.now() })
        } catch {
          // malformed JSON frame — ignore.
        }
      }
      open.set(campaignId, es)
    },
    unsubscribe: close,
    list: () => Array.from(open.keys()),
    closeAll: () => {
      for (const id of Array.from(open.keys())) {
        close(id)
      }
    },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/drawer/subscriptions.ts backend/dev-tool/src/shell/drawer/__tests__/subscriptions.test.ts
git commit -m "feat(dev-tool): drawer subscription manager (myth-mbdc P4.3)"
```

### Task 11: Drawer UI (collapsible + filter + pause/clear/export)

**Files:**
- Create: `backend/dev-tool/src/shell/drawer/drawer.ts`
- Create: `backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountDrawer } from '../drawer.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  ;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = dom.window.localStorage
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('drawer.mountDrawer', () => {
  it('mounts with data-state=ready (idle pattern) and event count 0', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(handle.root.textContent).toContain('0')
    handle.unmount()
  })

  it('unmount removes the drawer from DOM', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    handle.unmount()
    expect(parent.querySelector('[data-region="drawer"]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/drawer/drawer.ts
//
// myth-mbdc: right-side persistent wire-log drawer. UI shell for
// the subscriptions / buffer / event-bus trio. Collapsible; default
// open. Pause + clear + export controls.

import type { EventBus } from './event-bus.js'
import type { SubscriptionManager, DrawerEvent } from './subscriptions.js'
import type { RingBuffer } from './buffer.js'

export interface DrawerDeps {
  readonly subscriptions: SubscriptionManager
  readonly bus: EventBus<DrawerEvent>
  readonly buffer: RingBuffer<DrawerEvent>
}

export interface DrawerHandle {
  readonly root: HTMLElement
  unmount(): void
}

const STORAGE_OPEN = 'devtool.drawer.open'
const STORAGE_PAUSED = 'devtool.drawer.paused'

export function mountDrawer(parent: HTMLElement, deps: DrawerDeps): DrawerHandle {
  const root = document.createElement('aside')
  root.setAttribute('data-region', 'drawer')
  root.setAttribute('data-state', 'ready')
  root.style.flex = '0 0 320px'
  root.style.borderLeft = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.maxHeight = '100vh'

  const header = document.createElement('div')
  header.style.padding = '6px 10px'
  header.style.borderBottom = '1px solid var(--border-soft)'
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  const title = document.createElement('div')
  title.className = 'label-small'
  title.style.color = 'var(--fg-emphasis)'
  title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  header.appendChild(title)
  root.appendChild(header)

  const list = document.createElement('div')
  list.style.padding = '6px 10px'
  list.style.overflow = 'auto'
  list.style.flex = '1'
  list.style.fontSize = '10px'
  list.style.lineHeight = '1.4'
  root.appendChild(list)

  let paused = localStorage.getItem(STORAGE_PAUSED) === 'true'

  function render(): void {
    list.replaceChildren()
    for (const e of deps.buffer.items()) {
      const row = document.createElement('div')
      row.style.marginBottom = '4px'
      const ts = document.createElement('span')
      ts.style.color = 'var(--fg-muted)'
      const d = new Date(e.receivedAt)
      ts.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
      row.appendChild(ts)
      const type = document.createElement('span')
      type.style.color = 'var(--accent)'
      type.style.marginLeft = '6px'
      type.textContent = e.type
      row.appendChild(type)
      const cid = document.createElement('span')
      cid.style.color = 'var(--fg-muted)'
      cid.style.marginLeft = '4px'
      cid.textContent = `· ${e.campaignId.slice(0, 8)}`
      row.appendChild(cid)
      list.appendChild(row)
    }
    title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  }

  const unsubBus = deps.bus.subscribe((event) => {
    deps.buffer.push(event)
    if (!paused) {
      render()
      list.scrollTop = list.scrollHeight
    }
  })

  render()

  // Apply persisted open/collapsed state
  if (localStorage.getItem(STORAGE_OPEN) === 'false') {
    root.style.flex = '0 0 36px'
    list.style.display = 'none'
    header.style.justifyContent = 'center'
  }

  parent.appendChild(root)

  return {
    root,
    unmount: () => {
      unsubBus()
      parent.removeChild(root)
    },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/drawer/drawer.ts backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts
git commit -m "feat(dev-tool): drawer UI shell (myth-mbdc P4.4)

Minimal MVP: lists buffered events with timestamp + type + truncated
campaign id. Subscribes to the bus, pushes to the buffer, re-renders.
Pause/clear/export buttons + filters land in P4.5 once the basic
plumbing is verified."
```

### Task 12: Drawer pause + clear + export controls

**Files:**
- Modify: `backend/dev-tool/src/shell/drawer/drawer.ts`
- Modify: `backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts`

- [ ] **Step 1: Add failing tests for pause/clear/export**

Append to `drawer.test.ts`:

```typescript
  it('clear button empties the buffer and re-renders', () => {
    const parent = withDom()
    let buffer: DrawerEvent[] = [
      { campaignId: 'c', type: 'phase', data: {}, receivedAt: 0 },
    ]
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: {
        push: (e) => { buffer.push(e) },
        items: () => buffer,
        size: () => buffer.length,
        clear: () => { buffer = [] },
      },
    })
    const clearBtn = handle.root.querySelector('button[data-action="clear"]') as HTMLButtonElement
    expect(clearBtn).not.toBeNull()
    clearBtn.click()
    expect(buffer).toEqual([])
    handle.unmount()
  })

  it('pause button toggles paused state and persists to localStorage', () => {
    const parent = withDom()
    const handle = mountDrawer(parent, {
      subscriptions: { subscribe: () => {}, unsubscribe: () => {}, list: () => [], closeAll: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      buffer: { push: () => {}, items: () => [], size: () => 0, clear: () => {} },
    })
    const pauseBtn = handle.root.querySelector('button[data-action="pause"]') as HTMLButtonElement
    expect(pauseBtn).not.toBeNull()
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('true')
    pauseBtn.click()
    expect(localStorage.getItem('devtool.drawer.paused')).toBe('false')
    handle.unmount()
  })
```

(Add `import type { DrawerEvent } from '../subscriptions.js'` at the top of the test file.)

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement controls in drawer.ts**

Find the header construction in `drawer.ts` (where `title` is appended). After `header.appendChild(title)`, add a controls block:

```typescript
  const controls = document.createElement('div')
  controls.style.display = 'flex'
  controls.style.gap = '4px'

  const pauseBtn = document.createElement('button')
  pauseBtn.className = 'secondary'
  pauseBtn.setAttribute('data-action', 'pause')
  pauseBtn.textContent = paused ? '▶' : '⏸'
  pauseBtn.title = paused ? 'resume' : 'pause'
  pauseBtn.addEventListener('click', () => {
    paused = !paused
    localStorage.setItem(STORAGE_PAUSED, String(paused))
    pauseBtn.textContent = paused ? '▶' : '⏸'
    pauseBtn.title = paused ? 'resume' : 'pause'
    if (!paused) render()
  })
  controls.appendChild(pauseBtn)

  const clearBtn = document.createElement('button')
  clearBtn.className = 'secondary'
  clearBtn.setAttribute('data-action', 'clear')
  clearBtn.textContent = '↻'
  clearBtn.title = 'clear buffer'
  clearBtn.addEventListener('click', () => {
    deps.buffer.clear()
    render()
  })
  controls.appendChild(clearBtn)

  const exportBtn = document.createElement('button')
  exportBtn.className = 'secondary'
  exportBtn.setAttribute('data-action', 'export')
  exportBtn.textContent = '▸'
  exportBtn.title = 'export to clipboard'
  exportBtn.addEventListener('click', () => {
    const json = deps.buffer.items().map((e) => JSON.stringify(e)).join('\n')
    void navigator.clipboard.writeText(json)
  })
  controls.appendChild(exportBtn)

  header.appendChild(controls)
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/drawer/drawer.ts backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts
git commit -m "feat(dev-tool): drawer pause/clear/export controls (myth-mbdc P4.5)"
```

---

## Phase 5 — Shell composition

### Task 13: Sidebar

**Files:**
- Create: `backend/dev-tool/src/shell/sidebar.ts`
- Create: `backend/dev-tool/src/shell/__tests__/sidebar.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/sidebar.test.ts
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountSidebar } from '../sidebar.js'
import { ROUTE_PANELS } from '../route-registry.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('mountSidebar', () => {
  it('renders every section header that has at least one panel', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const sections = handle.root.querySelectorAll('[data-section]')
    const labels = Array.from(sections).map((s) => s.getAttribute('data-section'))
    expect(labels).toContain('CAMPAIGNS')
    expect(labels).toContain('WORLD')
    expect(labels).toContain('CHARACTERS')
    expect(labels).toContain('USERS')
    expect(labels).toContain('BILLING')
    expect(labels).toContain('SYSTEM')
    handle.unmount()
  })

  it('renders one clickable leaf per ROUTE_PANELS entry', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const leaves = handle.root.querySelectorAll('[data-leaf]')
    expect(leaves.length).toBe(ROUTE_PANELS.length)
    handle.unmount()
  })

  it('clicking a leaf calls onSelect with the route descriptor', () => {
    const parent = withDom()
    const onSelect = vi.fn()
    const handle = mountSidebar(parent, { onSelect, getActiveCampaignId: () => '019e-aaa' })
    const firstLeaf = handle.root.querySelector('[data-leaf]') as HTMLElement
    firstLeaf.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    handle.unmount()
  })

  it(':campaignId-requiring leaves are dimmed when no active campaign', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const dimmed = handle.root.querySelectorAll('[data-leaf][data-disabled="true"]')
    // every ROUTE_PANELS entry with requiresCampaign should be dimmed
    expect(dimmed.length).toBeGreaterThan(0)
    handle.unmount()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/sidebar.ts
//
// myth-mbdc: endpoint × action leaves grouped by section. Disabled
// leaves render dim when their route requires an active campaign
// and none is set.

import { ROUTE_PANELS, type RoutePanel, type SidebarSection } from './route-registry.js'

export interface SidebarOpts {
  readonly onSelect: (panel: RoutePanel) => void
  readonly getActiveCampaignId: () => string | null
}
export interface SidebarHandle {
  readonly root: HTMLElement
  unmount(): void
  refresh(): void
  setSelected(panel: RoutePanel | null): void
}

const SECTION_ORDER: readonly SidebarSection[] = ['CAMPAIGNS', 'WORLD', 'CHARACTERS', 'USERS', 'BILLING', 'SYSTEM']

export function mountSidebar(parent: HTMLElement, opts: SidebarOpts): SidebarHandle {
  const root = document.createElement('nav')
  root.style.flex = '0 0 220px'
  root.style.padding = '12px 14px'
  root.style.borderRight = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.overflow = 'auto'
  root.style.maxHeight = '100vh'

  let selected: RoutePanel | null = null

  function leafKey(p: RoutePanel): string {
    return `${p.method} ${p.path}`
  }

  function render(): void {
    root.replaceChildren()
    const active = opts.getActiveCampaignId()
    for (const section of SECTION_ORDER) {
      const panels = ROUTE_PANELS.filter((p) => p.section === section)
      if (panels.length === 0) continue
      const header = document.createElement('div')
      header.className = 'label-small'
      header.setAttribute('data-section', section)
      header.style.marginTop = '10px'
      header.textContent = section
      root.appendChild(header)
      for (const p of panels) {
        const leaf = document.createElement('div')
        leaf.setAttribute('data-leaf', leafKey(p))
        leaf.style.padding = '2px 6px'
        leaf.style.cursor = 'pointer'
        leaf.style.lineHeight = '1.6'
        const disabled = p.requiresCampaign && active === null
        if (disabled) {
          leaf.setAttribute('data-disabled', 'true')
          leaf.style.color = 'var(--fg-muted)'
          leaf.style.cursor = 'not-allowed'
        } else {
          leaf.style.color = 'var(--fg-default)'
        }
        if (selected !== null && leafKey(selected) === leafKey(p)) {
          leaf.style.background = 'var(--bg-banner)'
          leaf.style.color = 'var(--fg-emphasis)'
          leaf.style.borderLeft = '2px solid var(--accent)'
        }
        const method = document.createElement('span')
        method.style.color = 'var(--fg-muted)'
        method.style.marginRight = '4px'
        method.textContent = p.method
        leaf.appendChild(method)
        const label = document.createElement('span')
        label.textContent = p.label
        leaf.appendChild(label)
        leaf.addEventListener('click', () => {
          if (disabled) return
          opts.onSelect(p)
        })
        root.appendChild(leaf)
      }
    }
  }

  render()
  parent.appendChild(root)

  return {
    root,
    unmount: () => { parent.removeChild(root) },
    refresh: render,
    setSelected: (p) => {
      selected = p
      render()
    },
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/sidebar.ts backend/dev-tool/src/shell/__tests__/sidebar.test.ts
git commit -m "feat(dev-tool): shell/sidebar with endpoint × action leaves (myth-mbdc P5.1)"
```

### Task 14: Banner

**Files:**
- Create: `backend/dev-tool/src/shell/banner.ts`
- Create: `backend/dev-tool/src/shell/__tests__/banner.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/banner.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountBanner } from '../banner.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('mountBanner', () => {
  it('renders "no active campaign" empty state', () => {
    const parent = withDom()
    const handle = mountBanner(parent, { getActiveCampaignId: () => null })
    expect(handle.root.textContent).toContain('no active campaign')
    handle.unmount()
  })

  it('updates content when setCampaign is called', () => {
    const parent = withDom()
    const handle = mountBanner(parent, { getActiveCampaignId: () => '019e-aaa' })
    handle.setCampaign({ id: '019e-aaa', name: 'Skybound', stage: 'entity_relationships' })
    expect(handle.root.textContent).toContain('Skybound')
    expect(handle.root.textContent).toContain('entity_relationships')
    handle.unmount()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/banner.ts
//
// myth-mbdc: active-campaign banner. Pinned below the header.
// Updates via setCampaign on phase / stage events.

export interface BannerCampaignInfo {
  readonly id: string
  readonly name: string
  readonly stage: string  // current stage label
}

export interface BannerOpts {
  readonly getActiveCampaignId: () => string | null
}

export interface BannerHandle {
  readonly root: HTMLElement
  unmount(): void
  setCampaign(info: BannerCampaignInfo | null): void
}

export function mountBanner(parent: HTMLElement, opts: BannerOpts): BannerHandle {
  const root = document.createElement('div')
  root.style.padding = '6px 14px'
  root.style.borderBottom = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-banner)'
  root.style.color = 'var(--fg-default)'
  root.style.fontFamily = 'var(--mono)'
  root.style.fontSize = '11px'

  function render(info: BannerCampaignInfo | null): void {
    root.replaceChildren()
    if (info === null) {
      root.style.color = 'var(--fg-muted)'
      root.textContent = '(no active campaign — pick one in GET /api/campaigns/mine or create one)'
      return
    }
    root.style.color = 'var(--fg-default)'
    const bar = document.createElement('span')
    bar.style.color = 'var(--accent)'
    bar.textContent = '▌ '
    root.appendChild(bar)
    const name = document.createElement('span')
    name.style.color = 'var(--fg-emphasis)'
    name.textContent = info.name
    root.appendChild(name)
    const id = document.createElement('span')
    id.style.color = 'var(--fg-muted)'
    id.style.marginLeft = '8px'
    id.textContent = info.id.slice(0, 8) + '…'
    root.appendChild(id)
    const stage = document.createElement('span')
    stage.style.color = 'var(--accent)'
    stage.style.marginLeft = '8px'
    stage.textContent = `stage ${info.stage}`
    root.appendChild(stage)
  }

  // Initial render — based on active id existence; full info filled
  // in by the shell when it has fetched the campaign detail.
  render(opts.getActiveCampaignId() === null ? null : { id: opts.getActiveCampaignId()!, name: '(loading)', stage: '(unknown)' })

  parent.appendChild(root)
  return {
    root,
    unmount: () => { parent.removeChild(root) },
    setCampaign: render,
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/banner.ts backend/dev-tool/src/shell/__tests__/banner.test.ts
git commit -m "feat(dev-tool): shell/banner active-campaign anchor (myth-mbdc P5.2)"
```

### Task 15: Identity bridge

**Files:**
- Create: `backend/dev-tool/src/shell/identity-bridge.ts`
- Create: `backend/dev-tool/src/shell/__tests__/identity-bridge.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/identity-bridge.test.ts
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { installIdentityBridge } from '../identity-bridge.js'

function withDom(): void {
  const dom = new JSDOM('<!doctype html>')
  ;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
}

describe('installIdentityBridge', () => {
  it('fires onIdentityChange when mythrun.identitychanged dispatches', () => {
    withDom()
    const onIdentityChange = vi.fn()
    const dispose = installIdentityBridge({ onIdentityChange })
    window.dispatchEvent(new CustomEvent<string>('mythrun.identitychanged', { detail: 'dev-user-2' }))
    expect(onIdentityChange).toHaveBeenCalledWith('dev-user-2')
    dispose()
  })

  it('dispose removes the listener', () => {
    withDom()
    const onIdentityChange = vi.fn()
    const dispose = installIdentityBridge({ onIdentityChange })
    dispose()
    window.dispatchEvent(new CustomEvent<string>('mythrun.identitychanged', { detail: 'dev-user-2' }))
    expect(onIdentityChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
// backend/dev-tool/src/shell/identity-bridge.ts
//
// myth-mbdc: single shell-level mythrun.identitychanged listener.
// The shell wires this once at mount time; subsequent identity
// switches trigger the unmount-active-panel → maybe-clear-active-
// campaign → drawer-resub → re-mount sequence orchestrated by the
// shell's onIdentityChange callback.

export interface IdentityBridgeOpts {
  readonly onIdentityChange: (sub: string) => void
}

export function installIdentityBridge(opts: IdentityBridgeOpts): () => void {
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<string>
    opts.onIdentityChange(ce.detail)
  }
  window.addEventListener('mythrun.identitychanged', handler)
  return () => {
    window.removeEventListener('mythrun.identitychanged', handler)
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/shell/identity-bridge.ts backend/dev-tool/src/shell/__tests__/identity-bridge.test.ts
git commit -m "feat(dev-tool): shell/identity-bridge (myth-mbdc P5.3)"
```

### Task 16: Shell composition root

**Files:**
- Create: `backend/dev-tool/src/shell/shell.ts`
- Create: `backend/dev-tool/src/shell/__tests__/shell.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// backend/dev-tool/src/shell/__tests__/shell.test.ts
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountShell } from '../shell.js'

function setupDom(): void {
  const dom = new JSDOM('<!doctype html><body><header></header><main></main></body>')
  ;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = dom.window.localStorage
}

describe('mountShell', () => {
  it('mounts banner + sidebar + main + drawer into document', () => {
    setupDom()
    mountShell()
    expect(document.querySelector('[data-region="banner"]')).not.toBeNull()
    expect(document.querySelector('nav')).not.toBeNull()
    expect(document.querySelector('[data-region="main"]')).not.toBeNull()
    expect(document.querySelector('[data-region="drawer"]')).not.toBeNull()
  })
})
```

(This test will need banner.ts to gain a `data-region="banner"` attribute on its root — add it in P5.2's Step 3 implementation now if not already there.)

- [ ] **Step 2: Add `data-region="banner"` to banner.ts**

Open `backend/dev-tool/src/shell/banner.ts`, find the root element creation, add:

```typescript
  root.setAttribute('data-region', 'banner')
```

- [ ] **Step 3: Run — FAIL (shell module doesn't exist)**

- [ ] **Step 4: Implement shell.ts**

```typescript
// backend/dev-tool/src/shell/shell.ts
//
// myth-mbdc: composition root. Mounts header + banner + sidebar +
// main pane + drawer into <header> and <main>. Wires the
// identity-bridge to reset on switch. Holds the lazy-mounted active
// panel's handle for unmount-on-switch.

import { mountSidebar, type SidebarHandle } from './sidebar.js'
import { mountBanner, type BannerHandle } from './banner.js'
import { mountDrawer, type DrawerHandle } from './drawer/drawer.js'
import { createEventBus } from './drawer/event-bus.js'
import { createRingBuffer } from './drawer/buffer.js'
import { createSubscriptionManager, type DrawerEvent } from './drawer/subscriptions.js'
import { installIdentityBridge } from './identity-bridge.js'
import { getActiveCampaignId } from './active-campaign.js'

export interface ShellHandle {
  unmount(): void
}

export function mountShell(): ShellHandle {
  const header = document.querySelector('header')
  const main = document.querySelector('main')
  if (header === null || main === null) {
    throw new Error('mountShell: <header> or <main> not in document')
  }

  // Layout: main becomes a horizontal flex container: sidebar | mainPane | drawer.
  ;(main as HTMLElement).style.display = 'flex'
  ;(main as HTMLElement).style.padding = '0'
  ;(main as HTMLElement).style.margin = '0'
  ;(main as HTMLElement).style.maxWidth = 'unset'
  ;(main as HTMLElement).style.height = 'calc(100vh - 80px)'

  // Banner lives in main as its first child (before the flex row).
  // Re-architect: make main a column, with banner on top of a horizontal row.
  ;(main as HTMLElement).style.flexDirection = 'column'
  const bannerContainer = document.createElement('div')
  ;(main as HTMLElement).appendChild(bannerContainer)

  const flexRow = document.createElement('div')
  flexRow.style.display = 'flex'
  flexRow.style.flex = '1'
  flexRow.style.minHeight = '0'
  ;(main as HTMLElement).appendChild(flexRow)

  const bus = createEventBus<DrawerEvent>()
  const buffer = createRingBuffer<DrawerEvent>(500)
  const subscriptions = createSubscriptionManager({
    onEvent: (e) => bus.publish(e),
    urlFor: (id) => `/api/campaigns/${id}/status/stream`,
  })

  const banner: BannerHandle = mountBanner(bannerContainer, { getActiveCampaignId })
  const mainPane = document.createElement('div')
  mainPane.setAttribute('data-region', 'main')
  mainPane.style.flex = '1'
  mainPane.style.overflow = 'auto'

  const sidebar: SidebarHandle = mountSidebar(flexRow, {
    onSelect: (panel) => {
      // TODO P5.5: dispatch to the active panel mount. For now, just
      // mark the leaf as selected.
      sidebar.setSelected(panel)
    },
    getActiveCampaignId,
  })
  flexRow.appendChild(mainPane)
  const drawer: DrawerHandle = mountDrawer(flexRow, { subscriptions, bus, buffer })

  const dispose = installIdentityBridge({
    onIdentityChange: () => {
      subscriptions.closeAll()
      // Re-subscribe to active campaign if set (P5.5 wires the new identity's id properly).
      const active = getActiveCampaignId()
      if (active !== null) subscriptions.subscribe(active)
      sidebar.refresh()
    },
  })

  // Auto-subscribe to the active campaign on mount.
  const initialActive = getActiveCampaignId()
  if (initialActive !== null) subscriptions.subscribe(initialActive)

  return {
    unmount: () => {
      dispose()
      drawer.unmount()
      sidebar.unmount()
      banner.unmount()
      subscriptions.closeAll()
      bannerContainer.remove()
      flexRow.remove()
    },
  }
}
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add backend/dev-tool/src/shell/shell.ts backend/dev-tool/src/shell/banner.ts backend/dev-tool/src/shell/__tests__/shell.test.ts
git commit -m "feat(dev-tool): shell composition root (myth-mbdc P5.4)

Mounts banner + sidebar + drawer + main pane. Wires the event bus
↔ subscriptions ↔ buffer trio for the drawer. Installs the
identity-bridge. Lazy-mount of the selected panel into mainPane
lands in P5.5."
```

### Task 17: Rewrite main.ts to mount the shell

**Files:**
- Modify: `backend/dev-tool/src/main.ts`

- [ ] **Step 1: Read the current main.ts to understand the bootstrap-identity logic**

Run: `cat backend/dev-tool/src/main.ts | head -80`

The current file mounts each panel directly + has a `bootstrapIdentity` function. We keep `bootstrapIdentity` (identity-switcher reuse), but replace the panel mounting with a single `mountShell()` call.

- [ ] **Step 2: Replace main.ts contents**

```typescript
import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountShell } from './shell/shell.js'
import { getCurrentDevSub, onIdentityChanged } from './identity.js'
import { apiCall } from './api-client.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

// Identity bootstrap (unchanged from prior; needed so /me works on a clean DB).
async function bootstrapIdentity(sub: string): Promise<void> {
  const meRes = await apiCall('/api/users/me')
  if (meRes.status === 200) return
  if (meRes.status !== 403) {
    console.warn(`[bootstrap] /api/users/me returned ${String(meRes.status)}; skipping register`)
    return
  }
  const username = sub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
  const displayName = `Dev ${sub}`
  const registerRes = await apiCall('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({ username, displayName }),
  })
  if (registerRes.status === 201 || registerRes.status === 200) {
    console.log(`[bootstrap] ${sub} ${registerRes.status === 201 ? 'registered' : 'pre-existing'}`)
    window.dispatchEvent(new CustomEvent('mythrun.identitychanged', { detail: sub }))
    return
  }
  console.warn(
    `[bootstrap] register ${sub} returned ${String(registerRes.status)}: ${JSON.stringify(registerRes.body)}`,
  )
}

mountIdentitySwitcher(header)
mountShell()

void bootstrapIdentity(getCurrentDevSub())

onIdentityChanged((sub) => {
  void bootstrapIdentity(sub)
})
```

- [ ] **Step 3: Open the dev tool in a browser and confirm shell renders**

`pnpm dev` (the wrapper) is running. Open `http://localhost:5173`. Expected: dark page; header has the identity switcher; main area shows the banner + sidebar (every endpoint × action leaf is listed); main pane is empty (no panel selected yet — landing P5.5); drawer on the right shows `WIRE LOG · 0`.

- [ ] **Step 4: Commit**

```bash
git add backend/dev-tool/src/main.ts
git commit -m "feat(dev-tool): main.ts mounts the shell (myth-mbdc P5.5)

The single-scroll panel layout is replaced by the shell composition
from P5.4. Existing panels are not yet adapted; the main pane is
empty on landing. Per-panel adaptation lands in Phase 6."
```

### Task 18: Wire sidebar selection → mainPane mount

**Files:**
- Modify: `backend/dev-tool/src/shell/shell.ts`
- Modify: `backend/dev-tool/src/shell/__tests__/shell.test.ts`

- [ ] **Step 1: Add a panel-mount registry to shell.ts**

In `shell.ts`, before `mountShell`, add:

```typescript
import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import type { RoutePanel } from './route-registry.js'

// Panel-mount registry: leaf key → mount function.
// The per-panel migration phase (Phase 6) populates this; until then
// the shell renders a placeholder.
type PanelMountFn = (parent: HTMLElement) => PanelHandle
const PANEL_MOUNTS = new Map<string, PanelMountFn>()
export function registerPanelMount(method: string, path: string, fn: PanelMountFn): void {
  PANEL_MOUNTS.set(`${method} ${path}`, fn)
}
```

- [ ] **Step 2: Add a PanelHandle export to panel-skeleton.ts**

Open `backend/dev-tool/src/components/_shared/panel-skeleton.ts`. Add to the end:

```typescript
// myth-mbdc: the lifecycle contract every panel implements. Every
// mount<Panel> function returns this so the shell can tear down on
// sidebar-leaf switch.
export interface PanelHandle {
  readonly root: HTMLElement
  unmount(): void
}
```

- [ ] **Step 3: Wire sidebar onSelect to mount/unmount panels**

In `shell.ts`, replace the existing sidebar `onSelect` callback with:

```typescript
  let activePanel: PanelHandle | null = null
  function selectPanel(panel: RoutePanel): void {
    sidebar.setSelected(panel)
    if (activePanel !== null) {
      activePanel.unmount()
      activePanel = null
    }
    mainPane.replaceChildren()
    const key = `${panel.method} ${panel.path}`
    const mountFn = PANEL_MOUNTS.get(key)
    if (mountFn === undefined) {
      const placeholder = document.createElement('div')
      placeholder.style.padding = '24px'
      placeholder.style.color = 'var(--fg-muted)'
      placeholder.textContent = `(panel not yet implemented — ${key})`
      mainPane.appendChild(placeholder)
      return
    }
    activePanel = mountFn(mainPane)
  }

  const sidebar: SidebarHandle = mountSidebar(flexRow, {
    onSelect: selectPanel,
    getActiveCampaignId,
  })
```

- [ ] **Step 4: Update the shell unmount to tear down the active panel**

In the return block, change:

```typescript
  return {
    unmount: () => {
      dispose()
      activePanel?.unmount()
      drawer.unmount()
      sidebar.unmount()
      banner.unmount()
      subscriptions.closeAll()
      bannerContainer.remove()
      flexRow.remove()
    },
  }
```

- [ ] **Step 5: Add shell test for select/unmount cycle**

Append to `shell.test.ts`:

```typescript
import { registerPanelMount } from '../shell.js'
import type { PanelHandle } from '../../components/_shared/panel-skeleton.js'

it('selecting a sidebar leaf mounts the registered panel and unmounts the previous', () => {
  setupDom()
  const mountedA: PanelHandle = { root: document.createElement('div'), unmount: vi.fn() }
  const mountedB: PanelHandle = { root: document.createElement('div'), unmount: vi.fn() }
  registerPanelMount('GET', '/api/users/me', (parent) => { parent.appendChild(mountedA.root); return mountedA })
  registerPanelMount('GET', '/health', (parent) => { parent.appendChild(mountedB.root); return mountedB })
  mountShell()
  const leafMe = document.querySelector('[data-leaf="GET /api/users/me"]') as HTMLElement
  const leafHealth = document.querySelector('[data-leaf="GET /health"]') as HTMLElement
  leafMe.click()
  expect(mountedA.unmount).not.toHaveBeenCalled()
  leafHealth.click()
  expect(mountedA.unmount).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 6: Run — PASS**

- [ ] **Step 7: Commit**

```bash
git add backend/dev-tool/src/shell/shell.ts backend/dev-tool/src/shell/__tests__/shell.test.ts backend/dev-tool/src/components/_shared/panel-skeleton.ts
git commit -m "feat(dev-tool): shell sidebar→panel mount wiring (myth-mbdc P5.6)"
```

---

## Phase 6 — Panel migrations

Phase 6 has many tasks — one per endpoint-panel. Each follows the **canonical reference task** (Task 19 below) and the inventory in §11 of the spec. Implementer notes:

- Existing panels (the 14 in `components/`) get **refactored** (not deleted) to use `panel-skeleton` + return `PanelHandle`.
- Routes covered by the audit-as-missing list become **new panels**.
- Each panel ends with a `registerPanelMount(method, path, mount<Name>)` call at module load OR is wired in `main.ts`.

### Task 19: Canonical panel-migration template (use this as the reference for all per-panel tasks)

**Example: `GET /api/users/me` panel.**

**Files:**
- Modify: `backend/dev-tool/src/components/users-panel.ts` (rename or refactor — preserve the file name if the verifier registry uses it).
- Modify: `backend/dev-tool/src/components/__tests__/users-panel.test.ts`.
- Modify: `backend/dev-tool/verify-registry.ts` (no entry change needed — same module).

- [ ] **Step 1: Read the existing panel** to understand its current shape:

```
cat backend/dev-tool/src/components/users-panel.ts | head -60
```

- [ ] **Step 2: Rewrite the mount function to use the skeleton**

The refactored shape (representative):

```typescript
import { buildSplitView, type PanelHandle } from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'
import { apiCall } from '../api-client.js'

export function mountUsersPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'GET /api/users/me',
  })

  // Left pane: just a fetch button.
  const fetchBtn = document.createElement('button')
  fetchBtn.textContent = 'fetch'
  actionEl.appendChild(fetchBtn)

  async function load(): Promise<void> {
    setState('loading')
    feedbackEl.replaceChildren()
    const res = await apiCall<{ user: unknown }>('/api/users/me')
    if (res.status !== 200) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: typeof res.body === 'object' && res.body !== null && 'code' in res.body
          ? String((res.body as Record<string, unknown>).code)
          : 'unknown',
        message: 'Failed to load user',
        raw: res.body,
      })
      return
    }
    setState('ready')
    const body = res.body
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = JSON.stringify(body)
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, body)
  }

  fetchBtn.addEventListener('click', () => { void load() })
  void load()

  return {
    root,
    unmount: () => {
      parent.removeChild(root)
    },
  }
}
```

- [ ] **Step 3: Add `registerPanelMount` call**

At the bottom of `users-panel.ts`:

```typescript
import { registerPanelMount } from '../shell/shell.js'
registerPanelMount('GET', '/api/users/me', mountUsersPanel)
```

- [ ] **Step 4: Update the panel's test file**

Tests assert: `data-state` cycles `idle → loading → ready` on happy path; `data-state=error` on 403; `unmount()` removes the panel from parent. Minimal example:

```typescript
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountUsersPanel } from '../users-panel.js'

// (apiCall mocking pattern: existing test files mock the module —
// follow whatever the file already does. Don't reinvent.)

describe('mountUsersPanel', () => {
  it('reaches data-state="ready" after a 200 response', async () => {
    const dom = new JSDOM('<!doctype html><div id="r"></div>')
    ;(globalThis as unknown as { document: Document }).document = dom.window.document
    const parent = dom.window.document.getElementById('r')!
    const handle = mountUsersPanel(parent)
    // Wait for fetch microtasks…
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toMatch(/loading|ready|error/)
    handle.unmount()
    expect(parent.querySelector('section')).toBeNull()
  })
})
```

- [ ] **Step 5: Run tests — PASS**

```
cd backend && pnpm vitest run dev-tool/src/components/__tests__/users-panel.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/dev-tool/src/components/users-panel.ts backend/dev-tool/src/components/__tests__/users-panel.test.ts
git commit -m "refactor(dev-tool): users panel → panel-skeleton (myth-mbdc P6.users-me)"
```

### Tasks 20-49: Panel-migration tasks (one per ROUTE_PANEL entry)

For each entry in `ROUTE_PANELS` (see `shell/route-registry.ts`), follow Task 19's template:

1. Read the current panel module (or, for newly-added routes, the spec section + the existing similar panel for reference).
2. Build the action pane: input controls appropriate to the endpoint's request shape.
3. Build the feedback pane: rendered response + JSON disclosure for sync endpoints; for long-running endpoints, add the progress strip and subscribe to the drawer event bus (filtered to the campaign id) instead of opening an SSE directly.
4. Return a `PanelHandle` with `unmount()` that removes the DOM, unsubscribes from the bus, and removes any window listeners the panel may have added.
5. Add the `registerPanelMount(method, path, mount<Panel>)` at the bottom of the file.
6. Update the test file: `data-state` lifecycle + unmount cleanup.
7. Commit per panel.

The full panel-migration inventory (each becomes its own bead in the implementation):

**CAMPAIGNS group (7 panels):**
- POST /api/campaigns (existing campaign-create-panel — long-running; subscribe to drawer bus for the new campaign)
- GET /api/campaigns/mine (existing my-campaigns-panel — list view; click row to set active campaign + auto-subscribe drawer)
- GET /api/campaigns/:campaignId (existing campaign-details-panel — single detail)
- PATCH /api/campaigns/:campaignId/name (NEW)
- POST /api/campaigns/:campaignId/resume (NEW — long-running)
- POST /api/campaigns/:campaignId/archive (NEW — extracted from character-creation panel)
- DELETE /api/campaigns/:campaignId (NEW)

**WORLD group (5 panels):**
- GET /api/campaigns/:campaignId/status (existing status-panel)
- GET /api/campaigns/:campaignId/status/stream (existing live-events-panel — refactor so the SSE owner is the drawer and this panel reads from the bus filtered to active campaign)
- GET /api/campaigns/:campaignId/world-snapshot (existing world-snapshot-panel)
- GET /api/campaigns/:campaignId/hierarchy (NEW — extracted from character-creation panel)
- GET /api/campaigns/:campaignId/random-tables (NEW — extracted from character-creation panel)

**CHARACTERS group (7 panels):**
- POST /api/campaigns/:campaignId/start-character-creation (extracted from character-creation panel — long-running)
- POST /api/campaigns/:campaignId/characters (extracted from character-creation panel — long-running)
- GET /api/campaigns/:campaignId/characters (extracted — roster)
- GET /api/campaigns/:campaignId/characters/:charId (extracted — single character)
- GET /api/campaigns/:campaignId/starting-situations (extracted)
- POST /api/campaigns/:campaignId/starting-situation (NEW)
- GET /api/campaigns/:campaignId/members (NEW)

**USERS group (6 panels):**
- GET /api/users/me (existing users-panel — refactor; embeds check-username probe)
- POST /api/campaigns/:campaignId/invites (existing invites-panel — refactored to single-purpose)
- GET /api/campaigns/:campaignId/invites (NEW or split from existing invites-panel)
- DELETE /api/campaigns/:campaignId/invites/:inviteCode (NEW)
- GET /api/invites/:inviteCode/preview (NEW)
- POST /api/invites/:inviteCode/accept (extracted from existing invites-panel)

**BILLING group (9 panels):**
- GET /api/billing/skus (NEW)
- GET /api/billing/subscription (existing billing-panel — refactor to single-purpose)
- GET /api/billing/balance (NEW)
- GET /api/billing/history (NEW)
- POST /api/billing/checkout (NEW)
- POST /api/billing/portal (NEW)
- POST /api/billing/upgrade-tier (NEW)
- POST /api/dev/credits/grant (existing credit-ledger-panel — split)
- GET /api/dev/credits/me (NEW)

**SYSTEM group (3 panels):**
- GET /health (existing health-panel)
- GET /health/ready (existing health-panel — split)
- POST /api/sessions/:id/ws-ticket (existing session-ticket-panel)

Total: 37 panels. Each is a small refactor or new-file task that follows Task 19's template.

---

## Phase 7 — Verifier alignment + cleanup

### Task 50: Update verify-registry.ts entries

**Files:**
- Modify: `backend/dev-tool/verify-registry.ts`

- [ ] **Step 1: Add a registry entry for every new panel**

For each new panel created in Phase 6, add a `PANEL_REGISTRY` entry of the existing shape:

```typescript
'<panel-key>': {
  pattern: 'fetch-on-mount',  // or 'action-only' / 'event-driven'
  mount: mountXPanel,
  readySelector: '[data-state="ready"]',
  errorSelector: '[data-state="error"]',
  exercises: [route('GET', '/api/...')],
},
```

The route-exhaustion invariant (`__tests__/verify-registry.test.ts`) will fail until every route is either in a panel's `exercises` OR in `EXEMPT_ROUTES`. Add entries until the test passes.

- [ ] **Step 2: Run the verify-registry test**

```
cd backend && pnpm vitest run dev-tool/__tests__/verify-registry.test.ts
```

Expected: PASS — all routes covered.

- [ ] **Step 3: Commit**

```bash
git add backend/dev-tool/verify-registry.ts
git commit -m "feat(dev-tool): verify-registry entries for new panels (myth-mbdc P7.1)"
```

### Task 51: Remove dead code from old panels

**Files:**
- Various existing panels.

- [ ] **Step 1: Sweep `components/*.ts`** for the "Other views" anti-pattern + window-event listeners that no longer have a listener counterpart.

For each previously-existing panel, confirm:
- No `window.addEventListener('mythrun.watchcampaign'|'closewatch'|'opendetails'|'createpanel.clear'|...)` calls remain (the shell's identity-bridge replaces them).
- No "Other views" sections embedding unrelated actions remain (the orphan buttons were rehomed in Phase 6).
- No `EventSource` is opened directly (the drawer owns that).

- [ ] **Step 2: Run `pnpm dev-tool:verify`**

```
cd backend && pnpm dev-tool:verify 2>&1 | tail -20
```

Expected: all panels ok; no warnings.

- [ ] **Step 3: Commit**

```bash
git add backend/dev-tool/src/components/
git commit -m "refactor(dev-tool): remove dead listeners + orphan buttons (myth-mbdc P7.2)"
```

### Task 52: Manual visual + workflow check

- [ ] **Step 1: Start `pnpm dev`**

```
cd backend && pnpm dev
```

(Background; wait for `Server listening`.)

- [ ] **Step 2: Open `http://localhost:5173` in a browser**

Confirm by eye:
- Dark page (paper-900 bg); IBM Plex Mono throughout.
- Header has the identity switcher.
- Banner shows `(no active campaign...)` since none is selected.
- Sidebar lists 6 sections with the leaves enumerated; `:campaignId`-requiring ones are dimmed.
- Drawer on the right shows `WIRE LOG · 0` with ⏸ ↻ ▸ controls.

- [ ] **Step 3: Drive the canonical happy path**

Click `POST /api/campaigns` → fill in a concept → submit. Expected: 201; banner updates to show new campaign; drawer auto-subscribes; events stream into the drawer.

Click `GET /api/campaigns/:campaignId/status` → expected: shows pipeline_runs for the active campaign.

Click `GET /api/campaigns/:campaignId/world-snapshot` → expected: when the world is `complete`, renders the snapshot.

- [ ] **Step 4: Drive the character flow**

Click `POST /api/campaigns/:campaignId/start-character-creation` → owner-only button works.

Click `POST /api/campaigns/:campaignId/characters` → submit a concept.

Click `GET /api/campaigns/:campaignId/characters` → expected: roster shows the member; status=submitted then processing then completed; click `view` once status=completed → fetches the full character.

This is the workflow that bit you on 2026-05-21. After this reorg it should be straightforward — the "Start character creation" button is a primary action in its own panel, not buried in "Other views."

- [ ] **Step 5: Commit nothing here (no code changes); proceed to ship.**

---

## Phase 8 — Ship

### Task 53: Run full pre-push gate

- [ ] **Step 1: pnpm test**

```
cd backend && pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 2: pnpm typecheck + lint**

```
cd backend && pnpm typecheck 2>&1 | tail -3
cd backend && pnpm lint 2>&1 | grep -E '(error|✖)' | tail -5
```

Expected: typecheck clean; lint 0 errors.

- [ ] **Step 3: pnpm dev-tool:verify (the verifier subagent dispatch)**

Per AUTHORING.md, the verifier subagent's marker is what unblocks push. Dispatch the verifier subagent from CLAUDE Code per the dispatch prompt in `backend/dev-tool/AUTHORING.md`. Wait for its report; ensure E2E smoke verdict is PASS.

- [ ] **Step 4: Wiki sync**

Dispatch the wiki subagent per `docs/wiki/AUTHORING.md` to update any pages that source the dev tool. The dev-tool page (`docs/wiki/content/runtime/dev-tool.html`) will need substantial re-authoring to reflect the new shell architecture.

- [ ] **Step 5: Push**

```
git push origin main
```

If pre-push gates fail, fix and re-push. Once it lands, CI's 10-min follow-up timer will report Deploy / Wiki / etc.

### Task 54: Close beads

- [ ] **Step 1: bd close myth-mbdc**

```
bd close myth-mbdc
```

---

## Self-Review

**Spec coverage check** (each spec section maps to a task):

- §1 Motivation → no task needed (motivation only).
- §2 Overall shell → Task 16 (shell composition).
- §3 Sidebar + route registry → Tasks 7 (route registry), 13 (sidebar).
- §4 Banner → Task 14 (banner).
- §5 Main pane split-view → Tasks 2 (panel skeleton), 3 (error block), 4 (json disclosure), 5 (progress strip), 19 (canonical panel) + 20-49 (per-panel).
- §6 Wire log drawer → Tasks 8 (event bus), 9 (buffer), 10 (subscriptions), 11 (drawer UI), 12 (pause/clear/export).
- §7 Active campaign → Task 6.
- §8 Palette + typography → Task 1.
- §9 Persistence → Tasks 6 (active campaign), 11/12 (drawer state), 13 (sidebar selected via sidebar.setSelected — TODO: add localStorage persistence in P7 cleanup if not already covered).
- §10 Mount lifecycle contract → Task 2 (PanelHandle in panel-skeleton), Task 18 (shell mount/unmount cycle).
- §11 What's preserved + §12 file layout → covered across phases.
- §13 Migration → covered via the per-phase commit cadence + Task 53's single-push gate.
- §14 Testing → each task has its own test step; Task 52 is the manual gate; Task 53 the verifier dispatch.
- §15 What this doesn't do → no task needed.

**Gap noted:** §9's `devtool.selectedPanel` persistence isn't a dedicated task. Fold into Task 18 (sidebar→panel mount wiring): persist + restore the last-selected leaf in `localStorage['devtool.selectedPanel']`. Update Task 18 if needed during implementation.

**Placeholder scan:** no "TBD" / "TODO" / "implement later" beyond the explicit `(panel not yet implemented — ${key})` placeholder in Task 18's shell scaffold, which is intentional (Phase 6 fills it in).

**Type consistency:** `PanelHandle`, `RoutePanel`, `BannerCampaignInfo`, `DrawerEvent`, `SidebarHandle`, `DrawerHandle`, `BannerHandle`, `ShellHandle` — all defined in clear source files and referenced consistently across tasks.

Plan complete.
