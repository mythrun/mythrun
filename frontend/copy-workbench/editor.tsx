import { useState } from 'react'
import { entriesByKey, setValue, setCriticism, useEntryState, useCatalogText, useCatalogFilled } from './store.ts'
import { setActiveKey } from './highlight.tsx'
import type { Entry } from './types.ts'

const NON_TEXT_FLAGS = new Set(['consider-non-text', 'aria-label', 'brand-fixed', 'sr-only', 'sr-adjacent'])

function isWarnFlag(flag: string): boolean {
  return (
    flag.startsWith('dead-key') ||
    flag.startsWith('likely-dead') ||
    flag.startsWith('test-fixture') ||
    flag.startsWith('hardcoded-ds') ||
    NON_TEXT_FLAGS.has(flag)
  )
}

function critPlaceholder(entry: Entry): string {
  if (entry.flags.some((f) => NON_TEXT_FLAGS.has(f))) {
    return "Criticism — e.g. “this should be a wordmark/logomark, not text” or “this shouldn't be text at all”…"
  }
  return 'Criticism / notes — tone, length, “this shouldn’t be text at all”, …'
}

function harmonizeTargets(flags: string[]): string[] {
  return flags.filter((f) => f.startsWith('harmonize-with:')).map((f) => f.slice('harmonize-with:'.length))
}
function richTextFlag(flags: string[]): string | null {
  const f = flags.find((x) => x.startsWith('rich-text:'))
  return f ? f.slice('rich-text:'.length) : null
}
function fileLineHint(entry: Entry): string | null {
  // ds:* exampleHint leads with the source location (file:line …) — surface it.
  return entry.hardcoded && entry.exampleHint ? entry.exampleHint : null
}

function requiredTokens(current: string): string[] {
  return [...current.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1] ?? '')
}

/** Shared header row: key (click-to-copy) + kind/flag badges + notes. */
function EditorHead({ entry }: { entry: Entry }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const harmonize = harmonizeTargets(entry.flags)
  const rich = richTextFlag(entry.flags)
  const fileLine = fileLineHint(entry)
  const copyKey = (): void => {
    void navigator.clipboard?.writeText(entry.key)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 900)
  }
  return (
    <>
      <div className="wb-ed-top">
        <button type="button" className="wb-key" onClick={copyKey} title="click to copy the key">
          {copied ? 'copied!' : entry.key}
        </button>
        {entry.hardcoded && <span className="wb-badge" data-warn="true">DS default · not i18n</span>}
        {entry.kind === 'catalog' && <span className="wb-badge" data-warn="true">catalog · 20 lines</span>}
        {entry.kind === 'multiline' && <span className="wb-badge">prose</span>}
        {entry.interpolated && <span className="wb-badge">{'{{ }}'}</span>}
        {entry.flags.map((f) => (
          <span key={f} className="wb-badge" data-warn={isWarnFlag(f) ? 'true' : undefined}>
            {f}
          </span>
        ))}
      </div>
      {entry.description !== '' && <p className="wb-desc">{entry.description}</p>}
      {fileLine && <p className="wb-current">source: <code>{fileLine}</code></p>}
      {entry.current !== '' && (
        <p className="wb-current">
          current: <code>{entry.current}</code>
        </p>
      )}
      {harmonize.length > 0 && (
        <p className="wb-current" style={{ color: 'var(--wb-accent)' }}>
          ↔ keep in sync with: {harmonize.join(', ')}
        </p>
      )}
      {rich && (
        <p className="wb-current" style={{ color: 'var(--wb-accent)' }}>
          rich text — preserve the markers: <code>{rich}</code>
        </p>
      )}
    </>
  )
}

/** Parse the register names from the catalog exampleHint, e.g. "Sets: A
 *  landscape-forming, B records-and-ledgers, C small-and-ordinary." → the three
 *  register labels, index-aligned to the suggestion sets. */
function parseRegisters(hint: string): string[] {
  const m = hint.match(/Sets?:\s*([^.]+)\./i)
  if (!m?.[1]) return []
  return m[1].split(',').map((s) => s.trim().replace(/^[A-Za-z]\s+/, ''))
}

/** The catalog card: the 20 flavor lines edited as one textarea (one line per key),
 *  fanned out to worldGen.flavor1…flavor20. Chips replace the whole set. */
function CatalogEditor({ entry }: { entry: Entry }): React.JSX.Element {
  const text = useCatalogText(entry.key)
  const st = useEntryState(entry.key)
  const targets = entry.targetKeys ?? []
  const catalogRegisters = parseRegisters(entry.exampleHint)
  const filled = useCatalogFilled(entry.key)
  const focus = (): void => setActiveKey(entry.key)
  return (
    <div className="wb-editor" data-done={filled >= targets.length ? 'true' : undefined} onMouseEnter={focus} onMouseLeave={() => setActiveKey(null)}>
      <EditorHead entry={entry} />
      {entry.suggestions.length > 0 && (
        <div className="wb-chips">
          {entry.suggestions.map((s, i) => {
            const register = catalogRegisters[i]
            const preview = s.split('\n').slice(0, 2).join(' · ')
            return (
              <button
                key={i}
                type="button"
                className="wb-chip wb-chip--catalog"
                title="replace all 20 lines with this set"
                onClick={() => {
                  setValue(entry.key, s)
                  focus()
                }}
              >
                <b>Set {String.fromCharCode(65 + i)}{register ? ` · ${register}` : ''}</b>
                <span className="wb-chip-preview">{preview}…</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="wb-field">
        <span className="wb-field-label">
          your catalog · {lineCount}/{targets.length} lines filled · one line per flavor
        </span>
        <textarea
          className="wb-textarea"
          data-filled={lineCount > 0 ? 'true' : undefined}
          rows={Math.max(targets.length, 6)}
          value={text}
          spellCheck
          onFocus={focus}
          onChange={(e) => setValue(entry.key, e.target.value)}
        />
      </div>
      <div className="wb-crit">
        <textarea
          className="wb-textarea"
          data-filled={st.criticism.trim() !== '' ? 'true' : undefined}
          rows={1}
          value={st.criticism}
          placeholder="Criticism on the flavor set as a whole…"
          onChange={(e) => setCriticism(entry.key, e.target.value)}
        />
      </div>
    </div>
  )
}

/** One key's editor: header + suggestion chips + input + criticism. Focus/hover
 *  sets the active key so its exhibit slot highlights. Handles i18n keys, `ds:*`
 *  hardcoded constants (store-only), and prose. Catalog keys route to CatalogEditor. */
export function KeyEditor({ keyName, compact }: { keyName: string; compact?: boolean }): React.JSX.Element | null {
  const entry = entriesByKey[keyName]
  const st = useEntryState(keyName)
  if (!entry) return null
  if (entry.kind === 'catalog') return <CatalogEditor entry={entry} />

  const filled = st.value.trim() !== ''
  const multiline = entry.kind === 'multiline'
  const tokens = entry.interpolated ? requiredTokens(entry.current) : []
  const missingToken = filled && tokens.some((t) => !st.value.includes(`{{${t}}}`))

  const focus = (): void => setActiveKey(keyName)
  const blur = (): void => setActiveKey(null)

  return (
    <div className="wb-editor" data-done={filled ? 'true' : undefined} onMouseEnter={focus} onMouseLeave={blur}>
      {compact ? (
        <div className="wb-ed-top">
          <button type="button" className="wb-key" onClick={() => void navigator.clipboard?.writeText(keyName)} title="key">
            {keyName}
          </button>
          {entry.current !== '' && <span className="wb-badge">{entry.current}</span>}
        </div>
      ) : (
        <EditorHead entry={entry} />
      )}

      {entry.suggestions.length > 0 && (
        <div className="wb-chips">
          {entry.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="wb-chip"
              onClick={() => {
                setValue(keyName, s)
                focus()
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="wb-field">
        <span className="wb-field-label">
          your copy
          {missingToken && <span style={{ color: 'var(--wb-accent)' }}> · keep {tokens.map((t) => `{{${t}}}`).join(' ')}</span>}
        </span>
        {multiline ? (
          <textarea
            className="wb-textarea"
            data-filled={filled ? 'true' : undefined}
            rows={2}
            value={st.value}
            placeholder="type the chosen copy…"
            onFocus={focus}
            onChange={(e) => setValue(keyName, e.target.value)}
          />
        ) : (
          <input
            className="wb-input"
            data-filled={filled ? 'true' : undefined}
            value={st.value}
            placeholder="type the chosen copy…"
            onFocus={focus}
            onChange={(e) => setValue(keyName, e.target.value)}
          />
        )}
      </div>

      <div className="wb-crit">
        <textarea
          className="wb-textarea"
          data-filled={st.criticism.trim() !== '' ? 'true' : undefined}
          rows={1}
          value={st.criticism}
          placeholder={critPlaceholder(entry)}
          onChange={(e) => setCriticism(keyName, e.target.value)}
        />
      </div>

      {filled && (
        <div className="wb-ed-foot">
          <button type="button" className="wb-mini" onClick={() => setValue(keyName, '')}>
            revert to placeholder
          </button>
        </div>
      )}
    </div>
  )
}

/** A group of keys edited together (shared groupId). */
export function GroupEditor({ groupId, keys }: { groupId: string; keys: string[] }): React.JSX.Element {
  const firstKey = keys[0]
  const first = firstKey !== undefined ? entriesByKey[firstKey] : undefined
  return (
    <div>
      <div className="wb-group-note">
        group · {groupId} — {keys.length} strings edited together
        {first?.rationale ? ` · ${first.rationale}` : ''}
      </div>
      {keys.map((k) => (
        <KeyEditor key={k} keyName={k} compact />
      ))}
    </div>
  )
}

/** A compact "proposed for deletion / not wired" row: the criticism box stays (so
 *  Miklos can veto), but there is no input emphasis or live example. */
export function DeadEditor({ keyName, reason }: { keyName: string; reason: string }): React.JSX.Element | null {
  const entry = entriesByKey[keyName]
  const st = useEntryState(keyName)
  if (!entry) return null
  return (
    <div className="wb-editor" data-dead="true">
      <div className="wb-ed-top">
        <button type="button" className="wb-key" onClick={() => void navigator.clipboard?.writeText(keyName)} title="key">
          {keyName}
        </button>
        <span className="wb-badge" data-warn="true">{reason}</span>
        {entry.current !== '' && <span className="wb-badge">{entry.current}</span>}
      </div>
      {entry.description !== '' && <p className="wb-desc">{entry.description}</p>}
      <details className="wb-details">
        <summary>author anyway / veto the deletion</summary>
        <div className="wb-field">
          <input
            className="wb-input"
            data-filled={st.value.trim() !== '' ? 'true' : undefined}
            value={st.value}
            placeholder="copy (only if kept)…"
            onChange={(e) => setValue(keyName, e.target.value)}
          />
        </div>
        <div className="wb-crit">
          <textarea
            className="wb-textarea"
            data-filled={st.criticism.trim() !== '' ? 'true' : undefined}
            rows={1}
            value={st.criticism}
            placeholder="keep it? note why — otherwise it's proposed for deletion"
            onChange={(e) => setCriticism(keyName, e.target.value)}
          />
        </div>
      </details>
    </div>
  )
}
