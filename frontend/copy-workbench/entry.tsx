import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
// Latin-only @fontsource faces (Source Serif 4 400/600, IBM Plex Mono 400/500) —
// the DS's narrative-serif / machine-mono split. Vite inlines the woff2 as base64
// data: URIs (assetsInlineLimit), so the artifact needs no external font request.
import '@fontsource/source-serif-4/latin-400.css'
import '@fontsource/source-serif-4/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import { TooltipProvider } from '@mythrun/ui'
import { i18n } from '../src/i18n/config.ts'
import { installMatchMediaShim } from './theme-motion.ts'
import { initStore } from './store.ts'
import { App } from './App.tsx'
import './app.css'

// Force full motion (exhibits show the real, moving UI) before React mounts, then
// seed i18n with the inventory baseline + any stored overrides.
installMatchMediaShim()
initStore()

const container = document.getElementById('workbench-root')
if (container === null) throw new Error('workbench-root missing')
createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </I18nextProvider>
  </StrictMode>,
)
