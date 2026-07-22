// The RAW getCharacter → reveal view-model adapter was PROMOTED into client-core in
// MYT-94 (beside `sheetViewModel`), so the in-session sheet view-model can adapt the
// raw read brain-side (R1). This file stays as a thin delegation so the character-new
// route's existing imports keep working; the canonical implementation — and its
// dedicated unit tests — now live in `@mythrun/client-core/character`.
export { toRevealViewModel } from '@mythrun/client-core/character'
