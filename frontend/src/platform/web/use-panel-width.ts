import { useCallback, useState } from 'react'
import { readPanelWidth, writePanelWidth } from './panel-width.ts'

// usePanelWidth (MYT-100) — a docked side panel's persisted, clamped, resizable
// width, shared by the character-create wiki rail and the play knowledge rail (a
// ResizeHandle drives `onResize`). Seeds once from the stored value (clamped to
// [min, max], else `defaultWidth`); each resize clamps, updates, and persists under
// `key` through the web width store. Lives in platform/web/** (the storage read is
// a web global, R1) alongside the other web hooks.

export interface PanelWidthControl {
  /** The current width (px) — feed to the panel + the ResizeHandle `value`. */
  readonly width: number
  /** ResizeHandle `onChange` — clamps, updates, and persists the new width. */
  readonly onResize: (width: number) => void
}

/** A persisted, clamped, resizable panel width keyed by `key`. */
export function usePanelWidth(key: string, min: number, max: number, defaultWidth: number): PanelWidthControl {
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, w)), [min, max])
  const [width, setWidth] = useState<number>(() => clamp(readPanelWidth(key, defaultWidth)))
  const onResize = useCallback(
    (next: number): void => {
      const clamped = clamp(next)
      setWidth(clamped)
      writePanelWidth(key, clamped)
    },
    [key, clamp],
  )
  return { width, onResize }
}
