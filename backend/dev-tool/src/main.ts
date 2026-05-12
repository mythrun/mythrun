import './styles.css'

const main = document.querySelector<HTMLElement>('main')
if (!main) throw new Error('layout missing required element <main>')

const placeholder = document.createElement('p')
placeholder.textContent = '(no components mounted yet)'
main.appendChild(placeholder)
