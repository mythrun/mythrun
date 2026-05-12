import { mountIdentitySwitcher } from './components/identity-switcher.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)

const placeholder = document.createElement('p')
placeholder.textContent = '(health panel mounts next)'
main.appendChild(placeholder)
