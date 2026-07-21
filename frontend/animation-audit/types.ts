import type { ReactNode } from 'react'

/** One exhibit in the gallery: a single real component (or composite) driven
 *  exactly as its Storybook story drives it, shown in both light and dark. */
export interface AuditSection {
  /** Stable anchor id. */
  id: string
  /** Component / composite display name. */
  name: string
  /** Workspace path of the primary source. */
  path: string
  /** Where it appears in the app (one line). */
  where: string
  /** What drives it in the gallery (one line) + any reduced-motion note. */
  note: string
  /** Exhibit box height in px (each theme swatch gets this height). */
  height: number
  /** When set, the gallery auto-remounts the exhibit every N ms so a one-shot
   *  animation re-runs on a loop. Omit for continuously-animating exhibits. */
  autoReplayMs?: number
  /** Render the live exhibit. `reducedMotion` is the forced audit value (drives
   *  the prop channel); `replayKey` changes on Replay / auto-loop — use it as a
   *  React key on the animating subtree if the driver needs a clean remount. */
  render: (ctx: { reducedMotion: boolean; replayKey: number }) => ReactNode
}
