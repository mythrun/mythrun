import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountHealthPanel } from './components/health-panel.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)
mountHealthPanel(main)
