// Emulate the artifact host: wrap the wrapper-less single-file fragment in a full
// <!doctype> document (the host adds head/body around it) and serve it, so browser
// verification sees exactly what the artifact will render. Optional: stamp
// data-theme on <html> via ?theme=dark to emulate the host's theme toggle.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const port = Number(process.argv[3] ?? 5200)

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  const theme = url.searchParams.get('theme')
  const fragment = readFileSync(file, 'utf8')
  const themeAttr = theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html>
<html lang="en"${themeAttr}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
${fragment}
</body>
</html>`)
}).listen(port, () => {
  console.log(`serving ${file} at http://localhost:${port} (?theme=dark|light to emulate host toggle)`)
})
