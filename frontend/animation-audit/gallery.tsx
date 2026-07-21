import { useEffect, useRef, useState } from 'react'
import type { AuditSection } from './types.ts'
import {
  getForcedReducedMotion,
  observeHostTheme,
  setForcedReducedMotion,
  type AuditTheme,
} from './theme-motion.ts'

type MotionMode = 'full' | 'reduced'
type ThemePref = 'auto' | 'light' | 'dark'

/** One theme swatch: the exhibit rendered on a fixed DS token surface (light =
 *  `:root` default, dark = the DS `.dark` class). Independent of chrome theme. */
function Swatch({
  variant,
  section,
  reducedMotion,
  replayKey,
}: {
  variant: AuditTheme
  section: AuditSection
  reducedMotion: boolean
  replayKey: number
}): React.JSX.Element {
  return (
    <div className="audit-swatch-wrap">
      <div className="audit-swatch-label">{variant}</div>
      <div className={variant === 'dark' ? 'audit-swatch dark' : 'audit-swatch'}>
        {section.render({ reducedMotion, replayKey })}
      </div>
    </div>
  )
}

function SectionView({
  section,
  reducedMotion,
}: {
  section: AuditSection
  reducedMotion: boolean
}): React.JSX.Element {
  const [replayKey, setReplayKey] = useState(0)

  // Auto-loop one-shot exhibits.
  useEffect(() => {
    if (section.autoReplayMs === undefined) return
    const id = setInterval(() => {
      setReplayKey((k) => k + 1)
    }, section.autoReplayMs)
    return () => {
      clearInterval(id)
    }
  }, [section.autoReplayMs])

  return (
    <section className="audit-section" id={section.id}>
      <div className="audit-section__meta">
        <span className="audit-section__name">{section.name}</span>
        <code className="audit-section__path">{section.path}</code>
        <button
          type="button"
          className="audit-replay"
          onClick={() => {
            setReplayKey((k) => k + 1)
          }}
        >
          Replay
        </button>
        <span className="audit-section__where">In app: {section.where}</span>
        <span className="audit-section__note">{section.note}</span>
      </div>
      <div className="audit-swatches">
        <Swatch variant="light" section={section} reducedMotion={reducedMotion} replayKey={replayKey} />
        <Swatch variant="dark" section={section} reducedMotion={reducedMotion} replayKey={replayKey} />
      </div>
    </section>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="audit-ctl-group">
      <span>{label}</span>
      <div className="audit-seg">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => {
              onChange(o.value)
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Gallery({ sections }: { sections: AuditSection[] }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hostTheme, setHostTheme] = useState<AuditTheme>('light')
  const [themePref, setThemePref] = useState<ThemePref>('auto')
  const [motion, setMotion] = useState<MotionMode>('full')

  // Follow the artifact host's theme (data-theme + prefers-color-scheme).
  useEffect(() => observeHostTheme(setHostTheme), [])

  const chromeTheme: AuditTheme = themePref === 'auto' ? hostTheme : themePref

  // Reflect chrome theme onto the root for the chrome CSS.
  useEffect(() => {
    rootRef.current?.setAttribute('data-audit-theme', chromeTheme)
  }, [chromeTheme])

  // Drive both reduced-motion channels: the matchMedia shim (JS reads) and the
  // `.audit-force-reduced` class (the DS's CSS reset, on demand).
  const reducedMotion = motion === 'reduced'
  useEffect(() => {
    setForcedReducedMotion(reducedMotion)
    const root = rootRef.current
    if (root === null) return
    root.classList.toggle('audit-force-reduced', reducedMotion)
  }, [reducedMotion])

  // Keep the prop channel in sync if some other surface toggled the shim.
  useEffect(() => {
    if (getForcedReducedMotion() !== reducedMotion) setForcedReducedMotion(reducedMotion)
  }, [reducedMotion])

  return (
    <div ref={rootRef} className="audit-root" data-audit-theme={chromeTheme}>
      <header className="audit-header">
        <div className="audit-title">
          Mythrun — animation audit
          <small>{sections.length} exhibits · each shown light + dark</small>
        </div>
        <div className="audit-controls">
          <Segmented
            label="motion"
            value={motion}
            options={[
              { value: 'full', label: 'full' },
              { value: 'reduced', label: 'reduced' },
            ]}
            onChange={setMotion}
          />
          <Segmented
            label="chrome"
            value={themePref}
            options={[
              { value: 'auto', label: 'auto' },
              { value: 'light', label: 'light' },
              { value: 'dark', label: 'dark' },
            ]}
            onChange={setThemePref}
          />
        </div>
      </header>
      <main className="audit-main">
        <p className="audit-intro">
          Every complex animation in the Mythrun app, rendered with the real @mythrun/ui
          components on the real design-system CSS. Each exhibit is driven exactly as its
          Storybook story drives it. Left swatch is the light token surface, right is the DS
          dark surface — both always live. Use “motion” to force the reduced-motion variant
          regardless of your OS setting; “Replay” (or the auto-loop) re-runs one-shot beats.
        </p>
        {sections.map((s) => (
          <SectionView key={s.id} section={s} reducedMotion={reducedMotion} />
        ))}
      </main>
    </div>
  )
}
