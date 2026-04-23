// The upstream `@hpcc-js/wasm@2.33.2` ships `types/graphviz.d.ts` as a bare
// `export * from "@hpcc-js/wasm-graphviz"` that re-exports from a sibling
// package which is not listed as a dependency and is not installed. The
// runtime bundle at the `./graphviz` subpath is fine — it exports a
// `Graphviz` namespace with an async `load()` — but TypeScript resolves the
// subpath's types to an empty module. We augment the subpath here with the
// minimal slice of the API that `renderDot` actually uses. This keeps the
// code strictly typed without falling back to `any` or assertions.
declare module '@hpcc-js/wasm/graphviz' {
  export interface GraphvizRenderer {
    dot(source: string, format: 'svg' | 'dot' | 'json'): string
  }
  export const Graphviz: {
    load: () => Promise<GraphvizRenderer>
  }
}

import { Graphviz, type GraphvizRenderer } from '@hpcc-js/wasm/graphviz'

let cached: GraphvizRenderer | null = null

async function getGraphviz(): Promise<GraphvizRenderer> {
  cached ??= await Graphviz.load()
  return cached
}

function substituteAliases(source: string): string {
  // "ember" → ember-600 hex. Done as a whole-word quoted replacement so it
  // doesn't mangle node ids or attribute names.
  return source.replace(/"ember"/g, '"#8A5A3C"')
}

function injectHeader(source: string, header: string): string {
  if (header.length === 0) return source
  // Insert header just after the opening brace of the first graph/digraph block.
  const match = /^(\s*(?:di)?graph\s+[^{]*\{)/s.exec(source)
  if (match === null) {
    throw new Error('renderDot: could not locate opening graph brace to inject header')
  }
  const idx = match.index + match[0].length
  return `${source.slice(0, idx)}\n  ${header}\n${source.slice(idx)}`
}

export async function renderDot(source: string, header: string): Promise<string> {
  const prepared = substituteAliases(injectHeader(source, header))
  const graphviz = await getGraphviz()
  const raw = graphviz.dot(prepared, 'svg')
  // Strip the XML prolog and DOCTYPE — HTML5 parsers treat `<?xml ... ?>` as
  // a bogus comment when inlined, which renders inconsistently across browsers.
  // Return just the <svg>…</svg> slice for safe inline embedding in page bodies.
  const svgStart = raw.indexOf('<svg')
  if (svgStart === -1) {
    throw new Error('renderDot: Graphviz output did not contain an <svg element')
  }
  return raw.slice(svgStart)
}
