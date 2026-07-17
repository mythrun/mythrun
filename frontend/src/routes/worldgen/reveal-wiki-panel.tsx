// The wiki panel was PROMOTED out of the worldgen reveal in MYT-102 — the
// character-create screen mounts the same browsable panel, so the model + panel
// now live route-shared at routes/wiki-panel.tsx. This shim keeps the reveal's
// historical import path working unchanged (behavior-preserving re-export).
export {
  WikiPanel,
  useWikiModel,
  type FetchSnapshot,
  type WikiModelState,
  type WikiPanelProps,
} from '../wiki-panel.tsx'
