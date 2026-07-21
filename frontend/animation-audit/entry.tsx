import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Latin-only @fontsource faces (Source Serif 4 400/600, IBM Plex Mono 400/500) —
// the DS's narrative-serif / machine-mono split. Vite inlines the woff2 as base64
// data: URIs (assetsInlineLimit), so the artifact needs no external font request.
import '@fontsource/source-serif-4/latin-400.css'
import '@fontsource/source-serif-4/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import { installMatchMediaShim } from './theme-motion.ts'
import { Gallery } from './gallery.tsx'
import { allSections } from './sections/index.ts'
import './app.css'

// Install the controllable matchMedia shim BEFORE React mounts so the first read
// of `(prefers-reduced-motion: reduce)` (Spinner, usePrefersReducedMotion) resolves
// to the audit's forced value, not the OS setting.
installMatchMediaShim()

const container = document.getElementById('audit-root')
if (container === null) throw new Error('audit-root missing')
createRoot(container).render(
  <StrictMode>
    <Gallery sections={allSections} />
  </StrictMode>,
)
