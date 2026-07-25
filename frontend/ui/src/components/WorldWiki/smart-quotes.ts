// smart-quotes (ux-run2 myth-urtcn) — typographic quotes for rendered wiki prose.
// The generator writes straight typewriter quotes ('Mara Solenne'); inside the
// glossary's bookish serif definitions those read as a typo. This is a
// RENDERER-side transform (never persisted, never trusted to the generator):
// mechanical character substitution, conservative rules —
//   • a double/single quote at start-of-text, after whitespace, or after an
//     opening bracket OPENS (“ / ‘);
//   • every remaining straight quote CLOSES (” / ’) — which also covers the
//     word-internal apostrophe (Solenne’s, don’t) and the trailing possessive
//     (the lamplighters’).
// The known miss — a leading elision (’tis) rendering as an open quote — is
// accepted: quoted names are common in generated definitions, elisions are not.

const OPEN_DOUBLE = /(^|[\s([{])"/g
const OPEN_SINGLE = /(^|[\s([{])'(?=\S)/g

/** Straight quotes → typographic quotes, for display only. */
export function smartQuotes(text: string): string {
  return text
    .replace(OPEN_DOUBLE, '$1“')
    .replace(/"/g, '”')
    .replace(OPEN_SINGLE, '$1‘')
    .replace(/'/g, '’')
}
