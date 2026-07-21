import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { buildFlows, isDeadKey, deadReason } from './flows.ts'
import type { Flow, FlowItem } from './flows.ts'
import { scenesByFlow } from './scenes.tsx'
import { entriesByKey, data, buildExport, importFromJSON, useProgress, useFlowProgress } from './store.ts'
import { useActiveKey } from './highlight.tsx'
import { KeyEditor, GroupEditor, DeadEditor } from './editor.tsx'
import { ContextCard } from './context-card.tsx'
import { observeHostTheme, type ChromeTheme } from './theme-motion.ts'
import type { Scene } from './types.ts'

const flows = buildFlows()
const flowAuthorable: Record<string, number> = Object.fromEntries(
  flows.map((f) => [f.id, f.keys.filter((k) => entriesByKey[k]?.kind !== 'catalog').length]),
)

// ── Scene error boundary ─────────────────────────────────────────────────────
// A bad fixture or a component throw must degrade to the context card, never crash
// the workbench. Each exhibit render is wrapped in one of these.
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div>
          <div className="wb-scene-error">exhibit failed to render — showing the copy as a context card</div>
          {this.props.fallback}
        </div>
      )
    }
    return this.props.children
  }
}

// ── Editors for a set of keys (grouped by groupId, order preserved) ──────────
function itemsForKeys(keys: string[]): FlowItem[] {
  const items: FlowItem[] = []
  const gi = new Map<string, number>()
  for (const k of keys) {
    const g = entriesByKey[k]?.groupId
    if (g) {
      const at = gi.get(g)
      if (at === undefined) {
        gi.set(g, items.length)
        items.push({ type: 'group', groupId: g, keys: [k] })
      } else {
        const it = items[at]
        if (it && it.type === 'group') it.keys.push(k)
      }
    } else {
      items.push({ type: 'single', key: k })
    }
  }
  return items
}

function isSubsumed(k: string): boolean {
  return entriesByKey[k]?.subsumedBy != null
}
function isDead(k: string): boolean {
  const e = entriesByKey[k]
  return e ? isDeadKey(e) : false
}

function Editors({ keys }: { keys: string[] }): React.JSX.Element {
  // A scene may reference a subsumed/dead key in its exhibit, but its EDITOR belongs
  // to the catalog card / dead strip — never inline here.
  const own = keys.filter((k) => !isSubsumed(k) && !isDead(k))
  return (
    <div className="wb-editors">
      {itemsForKeys(own).map((item) =>
        item.type === 'group' ? (
          <GroupEditor key={`g:${item.groupId}`} groupId={item.groupId} keys={item.keys} />
        ) : (
          <KeyEditor key={item.key} keyName={item.key} />
        ),
      )}
    </div>
  )
}

/** The compact "proposed for deletion / not wired into the UI" strip for a flow. */
function DeadStrip({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <div className="wb-scene wb-scene--dead">
      <div className="wb-scene-head">
        <span className="wb-scene-kind" data-warn="true">proposed for deletion / not wired</span>
        <span className="wb-scene-title">{keys.length} strings the authors flagged as dead or not currently rendered</span>
        <span className="wb-scene-note">
          No live example (nothing renders these today). Author copy only to KEEP one — otherwise the criticism note is your veto.
        </span>
      </div>
      <div className="wb-editors">
        {keys.map((k) => {
          const e = entriesByKey[k]
          return e ? <DeadEditor key={k} keyName={k} reason={deadReason(e)} /> : null
        })}
      </div>
    </div>
  )
}

// ── Exhibit frame (the DS ground) with active-key highlight ──────────────────
function ExhibitFrame({
  tag,
  keys,
  minHeight,
  children,
}: {
  tag: string
  keys: string[]
  minHeight?: number | undefined
  children: ReactNode
}): React.JSX.Element {
  const active = useActiveKey()
  const hot = active !== null && keys.includes(active)
  return (
    <div className="wb-exhibit-wrap">
      <span className="wb-exhibit-tag">{tag}</span>
      <div className={`wb-exhibit${hot ? ' wb-hot' : ''}`} style={minHeight ? { minHeight } : undefined}>
        {children}
      </div>
    </div>
  )
}

// ── Blocks ───────────────────────────────────────────────────────────────────
function SceneBlock({ scene }: { scene: Scene }): React.JSX.Element {
  return (
    <div className="wb-scene">
      <div className="wb-scene-head">
        <span className="wb-scene-kind" data-real={scene.kind === 'real' ? 'true' : undefined}>
          {scene.kind === 'real' ? 'live component' : 'composed'}
        </span>
        <span className="wb-scene-title">{scene.title}</span>
        <span className="wb-scene-note">{scene.note}</span>
      </div>
      <SceneBoundary fallback={<ExhibitFrame tag="context card" keys={scene.keys}><ContextCard keys={scene.keys} /></ExhibitFrame>}>
        <ExhibitFrame tag="live UI · reflects your copy" keys={scene.keys} minHeight={scene.minHeight}>
          {scene.render()}
        </ExhibitFrame>
      </SceneBoundary>
      <Editors keys={scene.keys} />
    </div>
  )
}

function ContextBlock({ keys, title }: { keys: string[]; title?: string }): React.JSX.Element {
  return (
    <div className="wb-scene">
      {title && (
        <div className="wb-scene-head">
          <span className="wb-scene-kind">context card</span>
          <span className="wb-scene-title">{title}</span>
          <span className="wb-scene-note">
            The live copy in a faithful DS type role on the real token ground (no bespoke scene for this one yet).
          </span>
        </div>
      )}
      <ExhibitFrame tag="context card · reflects your copy" keys={keys}>
        <ContextCard keys={keys} />
      </ExhibitFrame>
      <Editors keys={keys} />
    </div>
  )
}

// ── Flow view ────────────────────────────────────────────────────────────────
function FlowView({ flow }: { flow: Flow }): React.JSX.Element {
  const scenes = scenesByFlow[flow.id] ?? []
  const covered = new Set<string>()
  for (const s of scenes) for (const k of s.keys) covered.add(k)
  // Dead keys → the dead strip (regardless of scene coverage). Subsumed keys → the
  // catalog card. Everything else uncovered → a context card. Leftovers at the KEY
  // level (not item) so a partly-covered group never drops its remaining members.
  const deadKeys = flow.keys.filter((k) => !isSubsumed(k) && isDead(k))
  const leftoverKeys = flow.keys.filter((k) => !covered.has(k) && !isSubsumed(k) && !isDead(k))
  const uncoveredItems = itemsForKeys(leftoverKeys)
  const authorable = flow.keys.filter((k) => entriesByKey[k]?.kind !== 'catalog').length

  return (
    <div>
      <div className="wb-flow-intro">
        <h2>{flow.label}</h2>
        <span>
          {authorable} strings{scenes.length > 0 ? ` · ${String(scenes.length)} live exhibit${scenes.length > 1 ? 's' : ''}` : ''}
          {deadKeys.length > 0 ? ` · ${String(deadKeys.length)} flagged dead` : ''}
        </span>
        {flow.blurb && <span style={{ flexBasis: '100%' }}>{flow.blurb}</span>}
      </div>

      {scenes.map((scene) => (
        <SceneBlock key={scene.id} scene={scene} />
      ))}

      {uncoveredItems.map((item) =>
        item.type === 'group' ? (
          <ContextBlock key={`g:${item.groupId}`} keys={item.keys} title={`group · ${item.groupId}`} />
        ) : (
          <ContextBlock key={item.key} keys={[item.key]} title={item.key} />
        ),
      )}

      {deadKeys.length > 0 && <DeadStrip keys={deadKeys} />}
    </div>
  )
}

// ── Search results ───────────────────────────────────────────────────────────
function SearchResults({ query }: { query: string }): React.JSX.Element {
  const q = query.toLowerCase()
  const hits = data.order.filter((k) => {
    const e = entriesByKey[k]
    if (!e) return false
    return (
      k.toLowerCase().includes(q) ||
      e.current.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.suggestions.some((s) => s.toLowerCase().includes(q))
    )
  })
  const shown = hits.slice(0, 150)
  return (
    <div>
      <div className="wb-flow-intro">
        <h2>Search</h2>
        <span>
          {hits.length} match{hits.length === 1 ? '' : 'es'} for “{query}”{hits.length > shown.length ? ` · showing first ${String(shown.length)}` : ''}
        </span>
      </div>
      {shown.map((k) => (
        <ContextBlock key={k} keys={[k]} title={k} />
      ))}
      {shown.length === 0 && <p style={{ color: 'var(--wb-ink-dim)', fontSize: 12 }}>No keys match.</p>}
    </div>
  )
}

// ── Import modal ─────────────────────────────────────────────────────────────
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  return (
    <div className="wb-modal" onClick={onClose}>
      <div className="wb-modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Import copy JSON</h3>
        <p>Paste a previously exported (or partial) workbench JSON to restore entries. Existing keys are overwritten.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "entries": { "play.roll.dc": { "value": "DC", "criticism": "" } } }' />
        {error && <p style={{ color: 'var(--wb-accent)' }}>{error}</p>}
        <div className="wb-modal-actions">
          <button type="button" className="wb-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="wb-btn wb-btn--primary"
            onClick={() => {
              try {
                const res = importFromJSON(text)
                onDone(`Imported ${String(res.applied)} keys${res.unknown ? ` (${String(res.unknown)} unknown skipped)` : ''}`)
                onClose()
              } catch {
                setError('Could not parse that JSON.')
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────
type ExhibitMode = 'auto' | 'light' | 'dark'

export function App(): React.JSX.Element {
  const [hostTheme, setHostTheme] = useState<ChromeTheme>('light')
  const [exhibitMode, setExhibitMode] = useState<ExhibitMode>('auto')
  const [selected, setSelected] = useState<string>(flows[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const progress = useProgress()
  const mainRef = useRef<HTMLDivElement>(null)

  const flowKeyMap = useMemo(() => Object.fromEntries(flows.map((f) => [f.id, f.keys])), [])
  const flowProgress = useFlowProgress(flowKeyMap)

  useEffect(() => observeHostTheme(setHostTheme), [])

  // Exhibit theme = the DS `.dark` class on the root (flips DS tokens for every
  // exhibit). Chrome stays on its own `--wb-*` palette keyed to the host theme.
  const resolvedExhibit = exhibitMode === 'auto' ? hostTheme : exhibitMode
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedExhibit === 'dark')
  }, [resolvedExhibit])

  const flow = flows.find((f) => f.id === selected) ?? flows[0]

  const flash = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2200)
  }

  const doExport = (): void => {
    const json = buildExport()
    void navigator.clipboard?.writeText(json).then(
      () => flash('Copied export JSON to clipboard'),
      () => flash('Clipboard blocked — use the downloaded file'),
    )
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mythrun-copy-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectFlow = (id: string): void => {
    setSelected(id)
    setQuery('')
    mainRef.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="wb-root" data-wb-theme={hostTheme}>
      <header className="wb-header">
        <span className="wb-title">
          Mythrun <b>Copy Workbench</b>
        </span>
        <div className="wb-progress" title="keys with chosen copy · keys with a criticism note">
          <div className="wb-meter">
            <i style={{ width: `${String((progress.entered / progress.total) * 100)}%` }} />
          </div>
          <span>
            {progress.entered} / {progress.total} entered · {progress.criticisms} notes
          </span>
        </div>
        <div className="wb-spacer" />
        <input
          className="wb-search"
          value={query}
          placeholder="search keys / copy…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="wb-progress" title="exhibit ground theme">
          <div className="wb-seg">
            {(['auto', 'light', 'dark'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={exhibitMode === m} onClick={() => setExhibitMode(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="wb-btn" onClick={() => setImportOpen(true)}>
          Import
        </button>
        <button type="button" className="wb-btn wb-btn--primary" onClick={doExport}>
          Export
        </button>
      </header>

      <div className="wb-body">
        <nav className="wb-rail">
          <div className="wb-rail-head">Flows · {flows.length}</div>
          {flows.map((f) => {
            const done = flowProgress[f.id] ?? 0
            const total = flowAuthorable[f.id] ?? f.keys.length
            return (
              <button
                key={f.id}
                type="button"
                className="wb-flow"
                aria-current={!query && f.id === flow?.id ? 'true' : undefined}
                onClick={() => selectFlow(f.id)}
              >
                <span className="wb-flow-name">{f.label}</span>
                <span className="wb-flow-dot">
                  <i style={{ width: `${String((done / Math.max(1, total)) * 100)}%` }} />
                </span>
                <span className="wb-flow-count">
                  {done}/{total}
                </span>
              </button>
            )
          })}
        </nav>

        <main className="wb-main" ref={mainRef}>
          {query ? <SearchResults query={query} /> : flow ? <FlowView flow={flow} /> : null}
        </main>
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={flash} />}
      {toast && <div className="wb-toast">{toast}</div>}
    </div>
  )
}
