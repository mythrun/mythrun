import { useSyncExternalStore } from 'react'
import { i18n } from '../src/i18n/config.ts'
import { defaultNS } from '@mythrun/client-core/i18n'
import rawData from './data.json'
import type { CopyData, Entry, KeyEntryState } from './types.ts'

export const data = rawData as CopyData
export const entriesByKey = data.entries

/** Sample interpolation values so `{{var}}` keys resolve to readable exhibit text. */
export const SAMPLE_VARS: Record<string, string> = {
  name: 'Miklos',
  names: 'Ren and Ada',
  count: '3',
  sessions: '4',
  when: '2 days ago',
  time: '2:10',
  level: '3',
  amount: '$5.00',
  price: '$8',
  tier: 'Patron',
  available: '2',
  required: '5',
  total: '3',
  current: '1',
}

const STORAGE_KEY = 'mythrun-copy-workbench-v1'

/** A real i18n catalog key (drivable through i18next). Catalog META keys and `ds:*`
 *  hardcoded constants are NOT — they're owned by the store only. */
export function isI18nKey(key: string): boolean {
  const e = entriesByKey[key]
  if (!e) return true // unknown keys (e.g. an extra flavor line) — treat as i18n-shaped
  return e.kind !== 'catalog' && !e.hardcoded
}

// ── Override state ─────────────────────────────────────────────────────────
const state = new Map<string, KeyEntryState>()
const listeners = new Set<() => void>()

function emitStore(): void {
  for (const fn of listeners) fn()
}

function repaint(): void {
  i18n.emit('languageChanged', i18n.language)
}

function persist(): void {
  const obj: Record<string, KeyEntryState> = {}
  for (const [k, v] of state) {
    if (v.value !== '' || v.criticism !== '') obj[k] = v
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: obj, savedAt: new Date().toISOString() }))
  } catch {
    /* storage full / unavailable — the session still works in-memory */
  }
}

const EMPTY: KeyEntryState = { value: '', criticism: '' }

/** Write one key's value into state (+ i18n if it's a real i18n key). No repaint /
 *  persist / notify — the public setters batch those so a fan-out is one update. */
function applyValue(key: string, value: string): void {
  const prev = state.get(key) ?? EMPTY
  state.set(key, { value, criticism: prev.criticism })
  if (isI18nKey(key)) {
    const resolved = value.trim() === '' ? (entriesByKey[key]?.current ?? '') : value
    i18n.addResource('en', defaultNS, key, resolved)
  }
}

/** Seed i18n with every real i18n key's CURRENT placeholder, then replay stored
 *  overrides. `ds:*` + catalog keys are skipped for i18n (owned by the store). */
export function initStore(): void {
  for (const key of data.order) {
    if (isI18nKey(key)) i18n.addResource('en', defaultNS, key, entriesByKey[key]?.current ?? '')
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { entries?: Record<string, KeyEntryState> }
      for (const [key, val] of Object.entries(parsed.entries ?? {})) {
        const clean: KeyEntryState = { value: val.value ?? '', criticism: val.criticism ?? '' }
        state.set(key, clean)
        if (clean.value !== '' && isI18nKey(key)) {
          const resolved = clean.value.trim() === '' ? (entriesByKey[key]?.current ?? '') : clean.value
          i18n.addResource('en', defaultNS, key, resolved)
        }
      }
    }
  } catch {
    /* corrupt storage — start clean */
  }
  repaint()
}

export function getEntryState(key: string): KeyEntryState {
  return state.get(key) ?? EMPTY
}

/** The effective display text for a key: an override value if present, else the
 *  original placeholder. Used for `ds:*` context cards (i18n exhibits read t()). */
export function displayValue(key: string): string {
  const st = state.get(key)
  if (st && st.value.trim() !== '') return st.value
  return entriesByKey[key]?.current ?? ''
}

/** The catalog textarea text: one effective line per target key (override ?? current). */
export function catalogText(catalogKey: string): string {
  const targets = entriesByKey[catalogKey]?.targetKeys ?? []
  return targets.map((k) => displayValue(k)).join('\n')
}

export function setValue(key: string, value: string): void {
  const entry = entriesByKey[key]
  if (entry?.kind === 'catalog') {
    const targets = entry.targetKeys ?? []
    const lines = value.split('\n')
    const n = Math.max(lines.length, targets.length)
    for (let i = 0; i < n; i += 1) {
      const targetKey = targets[i] ?? `worldGen.flavor${String(i + 1)}`
      applyValue(targetKey, lines[i] ?? '')
    }
  } else {
    applyValue(key, value)
  }
  repaint()
  persist()
  emitStore()
}

export function setCriticism(key: string, criticism: string): void {
  const prev = state.get(key) ?? EMPTY
  state.set(key, { value: prev.value, criticism })
  persist()
  emitStore()
}

// ── React binding ──────────────────────────────────────────────────────────
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useEntryState(key: string): KeyEntryState {
  return useSyncExternalStore(
    subscribe,
    () => state.get(key) ?? EMPTY,
    () => EMPTY,
  )
}

/** Live catalog text (one effective line per target). A plain string, so
 *  useSyncExternalStore's Object.is check dedupes equal snapshots. */
export function useCatalogText(catalogKey: string): string {
  return useSyncExternalStore(
    subscribe,
    () => catalogText(catalogKey),
    () => catalogText(catalogKey),
  )
}

/** How many of a catalog's target keys carry an actual override (not the seeded
 *  placeholder) — the honest "entered" count, matching the global progress meter. */
export function useCatalogFilled(catalogKey: string): number {
  return useSyncExternalStore(subscribe, () => {
    const targets = entriesByKey[catalogKey]?.targetKeys ?? []
    let n = 0
    for (const k of targets) if ((state.get(k)?.value ?? '').trim() !== '') n += 1
    return n
  })
}

export interface Progress {
  entered: number
  criticisms: number
  total: number
}

function isCounted(key: string): boolean {
  return entriesByKey[key]?.kind !== 'catalog'
}

function computeProgress(): Progress {
  let entered = 0
  let criticisms = 0
  for (const [k, v] of state) {
    if (isCounted(k) && v.value.trim() !== '') entered += 1
    if (v.criticism.trim() !== '') criticisms += 1
  }
  return { entered, criticisms, total: data.meta.authorable }
}

let progressCache: Progress = { entered: 0, criticisms: 0, total: data.meta.authorable }
let progressDirty = true
listeners.add(() => {
  progressDirty = true
})

export function useProgress(): Progress {
  return useSyncExternalStore(subscribe, () => {
    if (progressDirty) {
      progressCache = computeProgress()
      progressDirty = false
    }
    return progressCache
  })
}

/** Per-flow entered counts over authorable keys (excludes catalog META keys). */
export function useFlowProgress(flowKeys: Record<string, string[]>): Record<string, number> {
  return useSyncExternalStore(subscribe, () => {
    const out: Record<string, number> = {}
    for (const [flow, keys] of Object.entries(flowKeys)) {
      let n = 0
      for (const k of keys) if (isCounted(k) && (state.get(k)?.value ?? '').trim() !== '') n += 1
      out[flow] = n
    }
    return snapshotFlowProgress(out)
  })
}

let flowProgressSnap = ''
let flowProgressVal: Record<string, number> = {}
function snapshotFlowProgress(next: Record<string, number>): Record<string, number> {
  const sig = JSON.stringify(next)
  if (sig !== flowProgressSnap) {
    flowProgressSnap = sig
    flowProgressVal = next
  }
  return flowProgressVal
}

// ── Export / import ──────────────────────────────────────────────────────────
export function buildExport(): string {
  const entries: Record<string, KeyEntryState> = {}
  for (const [k, v] of state) {
    // The catalog META key carries no value (its lines live on the 20 targets);
    // still export a standalone criticism note on it if present.
    if (v.value.trim() === '' && v.criticism.trim() === '') continue
    entries[k] = { value: v.value, criticism: v.criticism }
  }
  const progress = computeProgress()
  return JSON.stringify(
    {
      meta: {
        tool: 'mythrun-copy-workbench',
        version: 2,
        exportedAt: new Date().toISOString(),
        authorable: progress.total,
        entered: progress.entered,
        criticisms: progress.criticisms,
      },
      entries,
    },
    null,
    2,
  )
}

/** Restore from an exported/partial JSON blob. Returns applied + unknown counts. */
export function importFromJSON(text: string): { applied: number; unknown: number } {
  const parsed = JSON.parse(text) as { entries?: Record<string, Partial<KeyEntryState>> }
  let applied = 0
  let unknown = 0
  for (const [key, val] of Object.entries(parsed.entries ?? {})) {
    const clean: KeyEntryState = { value: val.value ?? '', criticism: val.criticism ?? '' }
    state.set(key, clean)
    if (clean.value !== '' && isI18nKey(key)) {
      const resolved = clean.value.trim() === '' ? (entriesByKey[key]?.current ?? '') : clean.value
      i18n.addResource('en', defaultNS, key, resolved)
    }
    if (entriesByKey[key]) applied += 1
    else unknown += 1
  }
  repaint()
  persist()
  emitStore()
  return { applied, unknown }
}

export type { Entry }
